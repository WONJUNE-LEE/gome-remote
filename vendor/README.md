# Apache Guacamole JavaScript components

Version: 1.6.0. Source: https://archive.apache.org/dist/guacamole/1.6.0/source/guacamole-client-1.6.0.tar.gz

SHA-256: `81f9fd5a7b4377fb0ee295d0d4fec92e9667f2aafaa3d0ed8937f535deabdee4`

`guacamole.js` concatenates upstream modules in alphabetical order and adds an ESM default export. One local fix in `Display.drawStream` closes each decoded `VideoFrame` and `ImageDecoder` after drawing, and unblocks the render queue when decoding fails. Chromium emitted unclosed-frame warnings during the live RDP rehearsal before this fix.

`parser.js` is the unmodified upstream Parser module plus an ESM default export. Preserve LICENSE, NOTICE, and source headers when distributing.
