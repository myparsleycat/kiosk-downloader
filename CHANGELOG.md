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
