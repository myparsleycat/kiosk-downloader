# [1.10.0](https://github.com/myparsleycat/kiosk-downloader/compare/v1.9.4...v1.10.0) (2026-08-15)


### Bug Fixes

* harden scheduler concurrency and stale zip entry handling ([d2b6a82](https://github.com/myparsleycat/kiosk-downloader/commit/d2b6a8205693335055887058aedf5e25aef42d69))


### Features

* **transfer:** show per-collection request pool usage ([4c1ea5d](https://github.com/myparsleycat/kiosk-downloader/commit/4c1ea5d47d3b05847a650f04361cef61efa9ced9))

## [1.9.4](https://github.com/myparsleycat/kiosk-downloader/compare/v1.9.3...v1.9.4) (2026-08-12)


### Bug Fixes

* **download:** fix workupload captcha rejection and add ipv4 option ([361c931](https://github.com/myparsleycat/kiosk-downloader/commit/361c931fc36574da99cfd997f3151e5eb72eef32))
* **http:** preserve proxy routing and captcha retries ([007f5a7](https://github.com/myparsleycat/kiosk-downloader/commit/007f5a7688066f5b98eb2a621a1e5fc7c632c203))

## [1.9.3](https://github.com/myparsleycat/kiosk-downloader/compare/v1.9.2...v1.9.3) (2026-08-10)


### Bug Fixes

* **upload:** preserve undici for edge uploads ([8bcfca7](https://github.com/myparsleycat/kiosk-downloader/commit/8bcfca7ed12cd6a0b4e32724a3c634ec0dd9b49d))

## [1.9.2](https://github.com/myparsleycat/kiosk-downloader/compare/v1.9.1...v1.9.2) (2026-08-08)


### Bug Fixes

* **download:** route outbound requests through Chromium net stack ([6761656](https://github.com/myparsleycat/kiosk-downloader/commit/6761656ba36d8991c3292e284ab27cf027a9342f))
* **share-url:** accept unpadded and base64url-encoded download inputs ([400331a](https://github.com/myparsleycat/kiosk-downloader/commit/400331a8263b017f2f01d002afa5d97f63160407))

## [1.9.1](https://github.com/myparsleycat/kiosk-downloader/compare/v1.9.0...v1.9.1) (2026-08-08)


### Bug Fixes

* **download:** escalate stalled chunks after soft reconnects ([ea5731b](https://github.com/myparsleycat/kiosk-downloader/commit/ea5731b60cf506fdf398bf8aabb00adfff6090e3))
* **download:** preserve original error on non-slow-chunk failure ([4a35119](https://github.com/myparsleycat/kiosk-downloader/commit/4a3511937a21fa469489c6a55d45c86a91e56d39))

# [1.9.0](https://github.com/myparsleycat/kiosk-downloader/compare/v1.8.0...v1.9.0) (2026-08-08)


### Bug Fixes

* **download:** enrich Workupload error log context ([3f5c0f7](https://github.com/myparsleycat/kiosk-downloader/commit/3f5c0f7f40ed245b7292446273f2ad3583ccfed0))
* **download:** guard transfer control metadata parsing ([a99f4d3](https://github.com/myparsleycat/kiosk-downloader/commit/a99f4d319110e4ec8cdd818c59d292cfda9e955c))
* **download:** handle invalid Workupload metadata during restore ([294fdb9](https://github.com/myparsleycat/kiosk-downloader/commit/294fdb95ac92fda36d661f0ff933e16b5a84d42d))
* **download:** keep Workupload names consistent ([f8ee6f1](https://github.com/myparsleycat/kiosk-downloader/commit/f8ee6f12b232afb841e0457b46cee6424d1e1815))
* **download:** preserve zero-byte Workupload sizes ([b9dea61](https://github.com/myparsleycat/kiosk-downloader/commit/b9dea61ee1361ccab231cd42fbd9f133b8a4abd3))
* **download:** retry stalled Workupload bodies ([59adf7e](https://github.com/myparsleycat/kiosk-downloader/commit/59adf7e5e9de9073c3006b15f5c44f8248d0103c))
* **download:** throttle Workupload partial persistence ([83e37ca](https://github.com/myparsleycat/kiosk-downloader/commit/83e37ca38e040ba99fb0d4bbcd34aba97ab9e376))
* **download:** time out stalled Workupload CDN requests ([779ceb4](https://github.com/myparsleycat/kiosk-downloader/commit/779ceb429cef85ba9b6e8dd452dd5383c9a02cf2))
* **download:** tolerate invalid Workupload metadata ([62b778b](https://github.com/myparsleycat/kiosk-downloader/commit/62b778b9214eae2f1572664235a44c16a117618f))
* **download:** tolerate open connections after Workupload body completion ([451c217](https://github.com/myparsleycat/kiosk-downloader/commit/451c217b454038a66fa9cd664ec453d0dc2584d2))
* **download:** use loaded Workupload resource ([6b915d0](https://github.com/myparsleycat/kiosk-downloader/commit/6b915d0445cc0709a222aa6e219f2045f7b2f2c1))
* **download:** yield Workupload puzzle search ([8159a8d](https://github.com/myparsleycat/kiosk-downloader/commit/8159a8d8e18eb806848b6af59f354b7561e239cd))


### Features

* **download:** add Workupload download support ([ec8c098](https://github.com/myparsleycat/kiosk-downloader/commit/ec8c098cc71a2b640180e42e5b4fedf0fb5da360))
* **download:** show supported providers in empty state ([6c3e78b](https://github.com/myparsleycat/kiosk-downloader/commit/6c3e78b8386610833900a4473b24065d6a8979c7))

# [1.8.0](https://github.com/myparsleycat/kiosk-downloader/compare/v1.7.2...v1.8.0) (2026-07-27)


### Bug Fixes

* **download:** accept extended share strings on paste ([0302c06](https://github.com/myparsleycat/kiosk-downloader/commit/0302c060b924d5a1f3bc19424f3d6dd97990d1a1))
* **download:** atomically persist multi-piece reassembly progress ([6a9c686](https://github.com/myparsleycat/kiosk-downloader/commit/6a9c6868564d836491f0347a88ce3e36667ce6b8))
* **download:** clarify missing piece error in reassembly ([93f8f96](https://github.com/myparsleycat/kiosk-downloader/commit/93f8f96c7e8289373dedab6522a689512aaaed55))
* **download:** handle reassembly failures in coordinator restore replay ([a360f21](https://github.com/myparsleycat/kiosk-downloader/commit/a360f21a6fa75fdb050551d01f142fba2078ee17))
* **download:** order listBundleFiles deterministically by path and id ([a8b0731](https://github.com/myparsleycat/kiosk-downloader/commit/a8b07317c2a0f710b058254bc22a20986dc6f6fc))
* **download:** parse stored manifest defensively on restore and listing ([58013df](https://github.com/myparsleycat/kiosk-downloader/commit/58013df83a9898aa9a673163650df155ddb663eb))
* **download:** persist multi-piece reassembly progress for resume ([1ce1fa7](https://github.com/myparsleycat/kiosk-downloader/commit/1ce1fa70de0e4597b7906b3f41b3201121d97d2c))
* **download:** prevent unhandled rejection in reassembly cleanup ([26d69a4](https://github.com/myparsleycat/kiosk-downloader/commit/26d69a4cc7870ad354ce5b4a498b8b88b86eb854))
* **download:** reject arbitrary paths in readShareFile IPC ([231fc53](https://github.com/myparsleycat/kiosk-downloader/commit/231fc530060030ba37c186e17d00e41269ac778c))
* **download:** retain only most recent extended draft in cache ([aca2cdf](https://github.com/myparsleycat/kiosk-downloader/commit/aca2cdfc87d9d453a593cef18e85f042a30e8f83))
* **download:** smooth live progress during transfer ([ad1fe9d](https://github.com/myparsleycat/kiosk-downloader/commit/ad1fe9d6e06b2337c88ae0f6358e7a231071afa6))
* **download:** suppress part-path cleanup rejection in extended reassembly ([e31f40f](https://github.com/myparsleycat/kiosk-downloader/commit/e31f40f2ad0a86ba89a82b650ba8b6e14a2e2daf))
* **transfer:** avoid tight retry loop on progress flush failure ([aedf06a](https://github.com/myparsleycat/kiosk-downloader/commit/aedf06a56ab6e319e60ccc4762894a7302ac51eb))
* **transfer:** send dirty-only bundle progress patches ([c528500](https://github.com/myparsleycat/kiosk-downloader/commit/c528500b7abdadcad715581941e575cdb3ff4a51))
* **upload:** add keyboard activation to share/copy span ([a9dbeed](https://github.com/myparsleycat/kiosk-downloader/commit/a9dbeed68200a46c73c41c3a259dbb1b1855a35f))
* **upload:** clear turnstile window refs before async destroy ([d0d0724](https://github.com/myparsleycat/kiosk-downloader/commit/d0d0724373329b36547d94260a03174fe44e3977))
* **upload:** correct trie empty-child split and bundle dedup cleanup ([d8153ab](https://github.com/myparsleycat/kiosk-downloader/commit/d8153ab2d0b2c9712ca47877b33334880e0a0a58))
* **upload:** detach active worker listeners before terminate in destroy ([3e198ba](https://github.com/myparsleycat/kiosk-downloader/commit/3e198ba81cdf1986dd1685945fb175e6c3b9d8b3))
* **upload:** drop false collection upper bound and harden pack cap ([8a49b94](https://github.com/myparsleycat/kiosk-downloader/commit/8a49b94fbab8e05ad14f6e4242fd8c39e1dc968c))
* **upload:** exclude existing oversize files in compatible mode ([e17484e](https://github.com/myparsleycat/kiosk-downloader/commit/e17484e6287c16e5f5abcaa5b4daab126eb13316))
* **upload:** guard packEntries uploaded calc against zero-byte physical size ([f55eca1](https://github.com/myparsleycat/kiosk-downloader/commit/f55eca16d4331ab39e3d10c78985317ce002c4f3))
* **upload:** guard share info action in context menu ([88dd7b1](https://github.com/myparsleycat/kiosk-downloader/commit/88dd7b1b8e85391fdffd74ae99c874f88ae564b0))
* **upload:** log createIntegratedBundlePlan failures before generic error path ([222d693](https://github.com/myparsleycat/kiosk-downloader/commit/222d69360bbba0716acd9e263a2c674cb4d90d7f))
* **upload:** mark bundle notified only when failure notification is shown ([78c04e6](https://github.com/myparsleycat/kiosk-downloader/commit/78c04e6db4c2153e898bde3ade06f3da4c33bf5e))
* **upload:** run replace flow after in-flight bundle initialization ([5d016e5](https://github.com/myparsleycat/kiosk-downloader/commit/5d016e52591e59d53f02ece48b718938804c45e0))
* **upload:** serialize bundle init and harden worker queue ([5035994](https://github.com/myparsleycat/kiosk-downloader/commit/5035994c6dae0e81b0952ea2550f567d3b3b14e6))
* **upload:** serialize concurrent TurnstileSolver.solve calls ([8570d68](https://github.com/myparsleycat/kiosk-downloader/commit/8570d6842c69c188891ca41877b078ce029a8497))
* **upload:** serialize preparation worker and harden planning path ([18a2113](https://github.com/myparsleycat/kiosk-downloader/commit/18a2113c2eaf3d187a07c903800d492dfdd05a49))
* **upload:** settle pending mode/oversize resolvers before replacing and on unmount ([30067e3](https://github.com/myparsleycat/kiosk-downloader/commit/30067e326a9b8c129de74c4ea5dc41d6e572ab12))
* **upload:** validate file ownership against resolved bundle in pause/resume ([76f32bb](https://github.com/myparsleycat/kiosk-downloader/commit/76f32bbe6ac89f4e40f82c43d721552cdb78ee13))
* **utils:** render zero-duration elapsed time as 0 seconds ([3c0fbca](https://github.com/myparsleycat/kiosk-downloader/commit/3c0fbca24983f321f05fe7f5679d8802921146aa))


### Features

* add extended share upload and download reassembly ([4d444ad](https://github.com/myparsleycat/kiosk-downloader/commit/4d444add9d4839489d163c2cc9b85821c0b328a4))
* **share:** hash-trie packs and pack extract verify ([4978dd2](https://github.com/myparsleycat/kiosk-downloader/commit/4978dd2ffd4cc17916cc311a21d617c1aa06e49b))
* **upload:** deterministic global small-file packs ([4a8830b](https://github.com/myparsleycat/kiosk-downloader/commit/4a8830b3ea18f4ea8011256ab594fc6b660f599b))
* **upload:** plan progress UI and segment dedup metrics ([1216ac1](https://github.com/myparsleycat/kiosk-downloader/commit/1216ac1cc59b69c694d7fe06df31a967f0e485d8))


### Performance Improvements

* **download:** load bundle files once in buildBundleItem ([c2ec410](https://github.com/myparsleycat/kiosk-downloader/commit/c2ec410960b981a6c740c8a8024a219ccc1a0e83))
* **download:** preload bundle files during finalize ([6db2463](https://github.com/myparsleycat/kiosk-downloader/commit/6db246346a621437547ebcb5fc75d2ef14cd7379))
* **upload:** batch oversize draft file removals ([8124e88](https://github.com/myparsleycat/kiosk-downloader/commit/8124e882104753ad3758df13ccaa156d6c51ce65))
* **upload:** load bundle files once in buildBundleItem ([94086e3](https://github.com/myparsleycat/kiosk-downloader/commit/94086e34c476845dbb1741cafd660ee9f557349a))
* **upload:** move planning and pack materialization to worker thread ([b286a2c](https://github.com/myparsleycat/kiosk-downloader/commit/b286a2ca71ee9560e5fdc22a31b23e1db58f2232))

## [1.7.2](https://github.com/myparsleycat/kiosk-downloader/compare/v1.7.1...v1.7.2) (2026-07-22)


### Bug Fixes

* **download:** queue collections when slots are full ([1a90e56](https://github.com/myparsleycat/kiosk-downloader/commit/1a90e5650358cc5b4bc106975039bd2fa635e532))

## [1.7.1](https://github.com/myparsleycat/kiosk-downloader/compare/v1.7.0...v1.7.1) (2026-07-19)


### Bug Fixes

* **checkbox:** apply primary background to indeterminate state in dark mode ([d4729dd](https://github.com/myparsleycat/kiosk-downloader/commit/d4729dde57176a7b31b3b09beae1d4e240dd8f23))
* **download:** guard import button and align remove error message ([111ea3c](https://github.com/myparsleycat/kiosk-downloader/commit/111ea3cc6a27de707eb3cd5f39142bfb77e211d2))
* **metrics:** use monotonic clock for download speed sampling ([19e3f8d](https://github.com/myparsleycat/kiosk-downloader/commit/19e3f8df29ce0141555a740cf7cd54619ab3bfea))
* **settings:** remove hardcoded upload segment limit from description ([a6ed799](https://github.com/myparsleycat/kiosk-downloader/commit/a6ed799230b07114e2e6e8534fd25250d50f3611))
* **transfer-items:** flush pending items when initial load fails ([53abf71](https://github.com/myparsleycat/kiosk-downloader/commit/53abf71d8bc9cf7f2d302ead7fbe9d5191d7d8d1))

# [1.7.0](https://github.com/myparsleycat/kiosk-downloader/compare/v1.6.0...v1.7.0) (2026-07-15)


### Bug Fixes

* **downloads:** hide export for completed items ([f0e0794](https://github.com/myparsleycat/kiosk-downloader/commit/f0e0794969e7dfaf09a90aa7ff5c98c3c9ad8384))
* **ipc:** add upload:renameDraftSources contract channel ([810d996](https://github.com/myparsleycat/kiosk-downloader/commit/810d9963141ed088eb9388f298d716d5caf5daf1))
* **updater:** prevent release notes overflow in update dialog ([c099abe](https://github.com/myparsleycat/kiosk-downloader/commit/c099abeea63b487da047af4e7ca657a33067daba))
* **upload:** harden draft rename error handling ([464e704](https://github.com/myparsleycat/kiosk-downloader/commit/464e704f607d83b8a4e40719ed8fd1f5a2fcdb7c))


### Features

* add clear completed transfers button ([a47c070](https://github.com/myparsleycat/kiosk-downloader/commit/a47c070d9150f6c29e02102f47da87851302d724))
* **tree:** rename files and folders before download or upload ([611d445](https://github.com/myparsleycat/kiosk-downloader/commit/611d445942da914c5ccfbd59ce72f4454fdc1da3))

# [1.6.0](https://github.com/myparsleycat/kiosk-downloader/compare/v1.5.0...v1.6.0) (2026-07-15)


### Features

* **kdx:** add magic header and SHA-256 integrity check ([1e93a51](https://github.com/myparsleycat/kiosk-downloader/commit/1e93a518ea3cfbca198ca12b80ce4f6e4eda412f))

# [1.5.0](https://github.com/myparsleycat/kiosk-downloader/compare/v1.4.1...v1.5.0) (2026-07-15)


### Bug Fixes

* address validated review issues ([4445eb1](https://github.com/myparsleycat/kiosk-downloader/commit/4445eb1bc44372d55ca19e73277ad1c56d7230bc))
* **ipc-generator:** bootstrap types.gen.ts when missing ([32cfbf0](https://github.com/myparsleycat/kiosk-downloader/commit/32cfbf0ab679f6dfcb34756ad8e3296a5a8f5c11))


### Features

* add app update notifications ([01bdcfc](https://github.com/myparsleycat/kiosk-downloader/commit/01bdcfc3005c5f6f7c534df6e5965eb37a76a645))
* auto-try saved collection passwords on load ([1860e22](https://github.com/myparsleycat/kiosk-downloader/commit/1860e22960aadb1df197961abedf2d0fdc4ff957))
* **download:** add collection transfer export and import ([03e4cf6](https://github.com/myparsleycat/kiosk-downloader/commit/03e4cf694fa38f475efdc5343707233612755802))

## [1.4.1](https://github.com/myparsleycat/kiosk-downloader/compare/v1.4.0...v1.4.1) (2026-07-11)


### Bug Fixes

* **transfer:** disable shutdown setting before shutdown ([f51858f](https://github.com/myparsleycat/kiosk-downloader/commit/f51858f57ae000738d2c0a318157e828af576368))

# [1.4.0](https://github.com/myparsleycat/kiosk-downloader/compare/v1.3.0...v1.4.0) (2026-07-10)


### Bug Fixes

* **download:** reconcile transfer chunk layout ([ea8b07b](https://github.com/myparsleycat/kiosk-downloader/commit/ea8b07b611b27104fbb257f057db61b749a99499))


### Features

* **download:** adapt transfer concurrency on rate limits ([87ebb64](https://github.com/myparsleycat/kiosk-downloader/commit/87ebb6444b9d09ac0f5f46cd66377cdd237f8030))
* **settings:** add 16MB inflate buffer and default to 8MB ([1602db8](https://github.com/myparsleycat/kiosk-downloader/commit/1602db8fa00850113b5f1b6bd9d261a9c901a932))
* **settings:** add 8MB stream write batch and default to 2MB ([1071ad2](https://github.com/myparsleycat/kiosk-downloader/commit/1071ad2f1adb36a99736f17ce27848ee40524009))
* **settings:** confirm before enabling shutdown after transfer ([3820869](https://github.com/myparsleycat/kiosk-downloader/commit/38208696dfaba162ac545c14a12d8ccb2bf39bff))
* shut down system after transfers complete ([dabd24a](https://github.com/myparsleycat/kiosk-downloader/commit/dabd24a56d4d3f371d2ddeb421467ae162ee7dbd))
* **transfer:** smooth UI speed with time-based EMA ([bf86cd8](https://github.com/myparsleycat/kiosk-downloader/commit/bf86cd8da8ed8c93f132af843aca390c6fc1f5be))

# [1.3.0](https://github.com/myparsleycat/kiosk-downloader/compare/v1.2.0...v1.3.0) (2026-07-10)


### Bug Fixes

* **download:** preserve and resume partial chunks ([7bbbb84](https://github.com/myparsleycat/kiosk-downloader/commit/7bbbb84e18f35b03b0461f44c50f7e09bf95d114))
* **settings:** default asciiFilenames to off ([b88db69](https://github.com/myparsleycat/kiosk-downloader/commit/b88db695872d8c1766e2e669aba2cf597801dd96))
* **upload:** encode collection create sizes as bigint ([cf3c9c2](https://github.com/myparsleycat/kiosk-downloader/commit/cf3c9c2ea4ff3bba3bb267fb0afbd42f1ab661bb))
* **upload:** preserve completed files and elapsed time on pause ([f34fe46](https://github.com/myparsleycat/kiosk-downloader/commit/f34fe469b3ecbcbb0926b27b0b0a9b962fdc573b))


### Features

* auto-paste share URL into new download tab ([d8e6c89](https://github.com/myparsleycat/kiosk-downloader/commit/d8e6c89c32c9fc45e15d87a04a32539703a7ed68))
* **download:** add ASCII filename sanitization setting ([a3c0cff](https://github.com/myparsleycat/kiosk-downloader/commit/a3c0cffecc4563eec6b9525694d1920eabe97334))
* **download:** add transfer.it share download support ([7a98450](https://github.com/myparsleycat/kiosk-downloader/commit/7a984509e39934c219b4c1bb994aaafeb20ea6f1))
* **download:** browse and selectively extract ZIP entries ([76549ea](https://github.com/myparsleycat/kiosk-downloader/commit/76549ea5607c1c7925da942684bcbd3f9d614cf8))
* **settings:** separate upload queue retry and resume settings ([94c44d5](https://github.com/myparsleycat/kiosk-downloader/commit/94c44d5ef1ab17b64ed514008d5577c5b14b725a))
* **transfer:** add download and upload bandwidth limits ([46eea8f](https://github.com/myparsleycat/kiosk-downloader/commit/46eea8fced83442b7e6c31f1a0766ff564aa17f5))
* **transfer:** show OS taskbar progress for uploads and downloads ([d84a2fa](https://github.com/myparsleycat/kiosk-downloader/commit/d84a2faf963566e5a8c2267868763c3284a708bd))
* **upload:** add upload feature with kio.ac collection creation ([db38fee](https://github.com/myparsleycat/kiosk-downloader/commit/db38fee94e921c35a40527a6674e2fdf6d4e222c))
* **upload:** show file tree and error details in upload UI ([b704edc](https://github.com/myparsleycat/kiosk-downloader/commit/b704edcb06d891e1e2c0b3818f38bb5896d18795))
* **upload:** track real-time upload progress with streaming ([3b44269](https://github.com/myparsleycat/kiosk-downloader/commit/3b44269e44f9e1a51eab47546e6c2363c033a4b2))


### Performance Improvements

* **transfer:** batch incremental progress updates ([dcb6398](https://github.com/myparsleycat/kiosk-downloader/commit/dcb6398140d952aff8994a9030378a24719091af))

# [1.2.0](https://github.com/myparsleycat/kiosk-downloader/compare/v1.1.0...v1.2.0) (2026-07-09)


### Features

* **download:** decode base64-encoded share URLs ([ee58e03](https://github.com/myparsleycat/kiosk-downloader/commit/ee58e03d4e9326b51af64b73ceef2f5adb349728))

# [1.1.0](https://github.com/myparsleycat/kiosk-downloader/compare/v1.0.0...v1.1.0) (2026-07-09)


### Bug Fixes

* **ci:** pass dry-run flag correctly to semantic-release ([7c1556c](https://github.com/myparsleycat/kiosk-downloader/commit/7c1556ca91a9c2f273cc4b4d21d0d538f59dbde7))


### Features

* **download:** reconnect slow chunks up to twice ([be65b65](https://github.com/myparsleycat/kiosk-downloader/commit/be65b6591360a770f98d04fe5c1dd4d40df2e4a6))
