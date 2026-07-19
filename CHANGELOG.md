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
