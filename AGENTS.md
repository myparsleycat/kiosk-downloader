- Use parallel tools only for independent operations that do not depend on or mutate the same state.
- Prefer automation: execute requested actions without confirmation unless blocked by missing information, safety concerns, ambiguity about the destructive target, or irreversibility.
- Do not parallelize operations when one depends on another or when they modify the same files, Git state, database state, generated output, or shared resources.

## Subagent Usage

Use subagents proactively when a task would otherwise require broad codebase exploration, large-scale search, implementation planning, or initial discovery that would consume excessive main-thread context.

- Prefer delegating independent investigation work to subagents, such as mapping call sites, summarizing related files, comparing existing patterns, tracing side-effect flows, or checking whether a planned change touches multiple modules.
- Keep the main thread focused on coordination, deciding the implementation approach, making edits, and verifying the final result.
- Give subagents narrow, concrete prompts with explicit output expectations. Ask for concise findings with file paths, relevant symbols, and the reasoning needed to act, not broad narrative summaries.
- Use multiple subagents only for independent workstreams. Do not ask subagents to mutate the same files, Git state, database state, generated output, or shared resources in parallel.
- Do not offload final responsibility for project instructions, safety constraints, destructive actions, or the correctness of the implementation. The main agent must synthesize subagent findings and verify the result before reporting completion.

## Investigation Thoroughness

When tracing where an operation happens, such as a format conversion, side effect, or data write, do not stop at the primary or most-obvious path. Exhaustively map every occurrence reachable from the same flow:

- Side effects that run regardless of the option gating the primary path, such as derived, cover, or thumbnail images generated on every import.
- Independent call sites that perform the same operation under different conditions or entry points.
- Downstream workers, jobs, hooks, event handlers, or queue handlers triggered from the entry point.

Narrow the scope only when the user explicitly constrains it. If a grep already surfaced a candidate, investigate it before excluding it. An unexamined match is not an answer.

## Code Generation

The following auto-generated file is gitignored. On a fresh clone, run `pnpm dev` or `pnpm build` to generate it:

| File                         | Generator                  | Trigger                               |
| ---------------------------- | -------------------------- | ------------------------------------- |
| `src/shared/types.gen.ts`    | `plugins/ipc-generator.ts` | Vite buildStart / handler file change |
| `src/shared/ipc-keys.gen.ts` | `plugins/ipc-generator.ts` | same                                  |

Do not manually create or edit generated files.

## IPC Pattern

- Handlers: use `rh("channel:name", handlerFn)` from `src/main/ipc/helper.ts` (typed wrapper around `ipcMain.handle`)
- Preload exposes `window.api.invoke(channel, ...args)` (typed handler calls), `window.api.send(channel, ...args)`, and `window.api.on(channel, listener)` (typed events)
- Channel whitelisting is enforced at runtime via the generated `IPC_HANDLER_CHANNELS` / `IPC_SEND_CHANNELS` / `IPC_EVENT_CHANNELS` constant arrays
- To add a new IPC channel: add a handler file in `src/main/ipc/handlers/` using `rh()`, then restart dev server to regenerate types

## Error Logging

- For IPC-backed user actions, log the original error in the main process before rethrowing when the renderer will show a generic fallback message.
- Include enough structured context to diagnose the failure without reproduction: channel/action name, user-facing entity name, relevant domain identifiers, current operation/stage, input paths, resolved paths, external URLs or executable paths when relevant, and rollback/cleanup state.
- For multi-step operations, track and log the current operation/stage and any registered rollback or cleanup state.
- Preserve the original error message/code so renderer error handling can still match known sentinel and domain-specific error codes.

## Style Guide

### General Principles

- Keep things in one function unless extraction provides a clear structural benefit.
- Do not extract a single-use helper preemptively merely because a block can be moved.
- Keep simple and local expressions inline.
- Extract a helper when it:

  - Is reused.
  - Represents a genuine domain concept.
  - Hides a complex boundary.
  - Is independently meaningful.
  - Separates validation or supporting branches that obscure the main happy path.

- Avoid `try`/`catch` where it merely rethrows, hides, logs and ignores, or unnecessarily wraps an error.
- Use `try`/`catch` when it is needed for:

  - Recovery.
  - Resource cleanup.
  - Error translation at a system or domain boundary.
  - File-system operations requiring fallback behavior.
  - External APIs or subprocesses requiring controlled failure handling.
  - Parsing untrusted input when a schema helper cannot express the operation.

- Never silently swallow unexpected errors.
- Avoid using the `any` type.
- Rely on type inference when possible. Avoid explicit type annotations or interfaces unless necessary for exports, API boundaries, recursive types, generic constraints, or clarity.
- Prefer functional array methods such as `flatMap`, `filter`, and `map` when they improve clarity.
- Use type guards with `filter` to preserve downstream type inference.
- Prefer a loop when it provides clearer handling of:

  - Early termination.
  - Sequential asynchronous operations.
  - Stateful accumulation.
  - Multiple accumulators.
  - Large collections where intermediate arrays would be wasteful.
  - Immediate failure or cancellation.

- Do not use unbounded `Promise.all` for network, filesystem, CPU-heavy, or rate-limited operations.
- Reuse an existing project concurrency limiter when one exists. Otherwise apply an explicit bounded concurrency mechanism.
- Prioritize using `es-toolkit` where applicable when working with TypeScript.

Reduce total variable count by inlining values that are:

- Used only once.
- Simple.
- Pure.
- Clearer at the call site.

Do not inline a value when a name improves:

- Readability.
- Validation.
- Logging.
- Error reporting.
- Debugging.
- Reuse within a complex expression.
- Understanding of an asynchronous or side-effecting operation.

```ts
// Good
const journal = JSON.parse(await fse.readFile(path.join(dir, "journal.json"), "utf8"));

// Bad
const journalPath = path.join(dir, "journal.json");
const journal = JSON.parse(await fse.readFile(journalPath, "utf8"));
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a;
obj.b;

// Bad
const { a, b } = obj;
```

Use destructuring when it materially improves clarity, such as extracting a stable subset of values repeatedly used in a narrow scope. Do not destructure merely to shorten property access.

### Variables

Prefer `const` over `let`. Use ternaries, early returns, or small well-named helpers instead of reassignment when they remain clearer.

```ts
// Good
const foo = condition ? 1 : 2;

// Bad
let foo;
if (condition) foo = 1;
else foo = 2;
```

Do not replace straightforward control flow with a deeply nested or hard-to-read ternary solely to avoid `let`.

### Control Flow

Avoid unnecessary `else` statements. Prefer early returns when they make the control flow flatter and easier to read.

```ts
// Good
function foo() {
  if (condition) return 1;
  return 2;
}

// Bad
function foo() {
  if (condition) return 1;
  else return 2;
}
```

Do not force an early return when a symmetric conditional is clearer or when it would fragment closely related logic.

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function LoadThing(input: unknown) {
  const config = requireConfig(input);
  const metadata = readMetadata(input);
  return createThing({ config, metadata });
}

function requireConfig(input: unknown) {
  // ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers.
- Extract only when the helper names a real concept such as `requireConfig` or `readMetadata`, isolates a complex boundary, or keeps the main operation readable.
- Do not return `Effect` from helpers unless they actually perform effectful work.
- Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments only for non-obvious constraints, surprising behavior, or context the reader cannot recover from the code. Do not add comments that restate what the code already makes obvious.
- Do not write inertia-driven comments: section dividers (`// -----`), per-field or per-UI-section labels (`{/* name */}`, `// header`), numbered step narration (`// 1. ... // 2. ...`), or restating a function's purpose above its definition when the name and signature already convey it.
- A comment is justified when it captures a non-trivial reason: a server-side quirk, an external protocol constraint, a design tradeoff, a subtle ownership or lifecycle rule, or a surprising cause-and-effect that would mislead a reader who skipped the comment.
- When a comment only describes what the code does, remove it. When it describes why the code does it and the why is not obvious, keep it.

## Type Checking

- Do not run `tsc` directly.
- To type-check files, pass one or more file paths to `pnpm lint --`.

For example:

```sh
pnpm lint -- file/to/path file/to/path2
```

## Formatting

After modifying files, pass one or more modified file paths to `pnpm fmt --`.

For example:

```sh
pnpm fmt -- file/to/path file/to/path2
```

Do not run broad formatting against unrelated files unless the task explicitly requires it.

## Git Revert

When reverting multiple commits, revert them one at a time starting from the most recent commit and proceeding to the oldest to avoid conflicts.

Use `--no-commit` for every revert, inspect the combined result, and then create one commit.

```sh
git revert --no-commit <newest-commit>
git revert --no-commit <older-commit>
git commit -m "revert: remove unwanted changes"
```

Do not allow an intermediate revert command to create its own commit when the requested result is one combined revert commit.

## Commit

Commit messages must follow the Conventional Commits format.

```txt
<type>[optional scope]: <description>
```

Do not use a `body` or `footer`.

### Type

The allowed `type` values are:

```txt
feat
fix
docs
style
refactor
perf
test
build
ci
chore
revert
```

The main `type` values are defined as follows:

| Type       | Description                                 |
| ---------- | ------------------------------------------- |
| `feat`     | Adds a user-facing feature                  |
| `fix`      | Fixes a user-facing bug                     |
| `docs`     | Documentation-only changes                  |
| `refactor` | Code restructuring without behavior changes |
| `test`     | Adds or updates tests                       |
| `chore`    | Other maintenance tasks                     |

### Scope

Add a `scope` when it helps clarify the affected area of the change.

```txt
feat(auth): add login form
fix(api): handle empty response
docs(readme): update setup guide
```

### Description

The `description` should briefly and clearly describe the change.

```txt
feat: add user profile page
fix(auth): prevent expired token login
refactor(store): split user state module
test(login): add invalid password case
chore: update dependencies
```

### Examples

```txt
feat: add dark mode
feat(auth): add OAuth login
fix: handle null user
fix(modal): prevent close button overlap
docs: update README
refactor(api): simplify user service
test: add user service tests
chore: update eslint config
```
