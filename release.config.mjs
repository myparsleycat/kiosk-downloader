/**
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
    branches: ["main"],
    plugins: [
        "@semantic-release/commit-analyzer",
        "@semantic-release/release-notes-generator",
        "@semantic-release/changelog",
        [
            "@semantic-release/npm",
            {
                npmPublish: false,
            },
        ],
        [
            "@semantic-release/git",
            {
                assets: ["package.json", "CHANGELOG.md"],
                message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
            },
        ],
        [
            "@semantic-release/exec",
            {
                // Used by CI dry-run to decide whether to build installers.
                verifyReleaseCmd: 'echo "${nextRelease.version}" > .next-version',
            },
        ],
        "@semantic-release/github",
    ],
};
