# Lower Third Studio Desktop

An offline Electron version of the lower-third editor. Preview and editing remain in the web UI; final broadcast export runs through bundled native FFmpeg and is checked with FFprobe before the selected destination is replaced.

## Broadcast export

The **Broadcast MXF — DNxHD 120** action produces:

- MXF with 1920×1080 DNxHD at 120 Mb/s
- 25 fps, top-field-first interlaced video
- YUV 4:2:2, limited-range BT.709
- two discrete mono PCM streams, 24-bit at 48 kHz
- `company_name=BBC` and `product_name=Lower Third Studio`

Progressive inputs are converted to 1080i/25. Interlaced inputs are preserved as interlaced during scaling. Stereo audio is split into two mono streams; one-channel audio is duplicated; silent sources receive two silent mono streams.

The export is written to a temporary partial file, probed for the required stream properties and duration, and only then moved to the chosen `.mxf` destination. A failed or cancelled job does not replace an existing destination file.

## Run and package

```sh
npm install
npm start
npm run dist:win
npm run dist:mac
```

Platform binaries belong in `resources/bin/win/x64` and `resources/bin/mac/arm64`. The Windows target is a single portable executable. It is currently unsigned, so Windows SmartScreen may show a warning until a code-signing certificate is configured.

## Playback note

DNxHD/MXF is an editing and broadcast-delivery format. Many consumer players do not support it even when the file is valid. Use a professional NLE, broadcast system, or a player with DNxHD/MXF support for review.
