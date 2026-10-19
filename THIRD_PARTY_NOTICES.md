# Third-party notices

## Chat Dinger

DoneBell's composer-driven completion recognition in `src/content/selectors.ts`
was adapted from the Chat Dinger detection approach, with related state handling
in `src/content/detector.ts` and `src/content/index.ts`. This notice covers those
derived portions. DoneBell's original code and artwork are separately covered
by the MIT License in LICENSE.

Upstream: https://github.com/rumblelab/chatdinger

The upstream license text below was verified against LICENSE at commit
`bc9d96e9331d9365185e04b735dbe944616f9dfb`:
https://github.com/rumblelab/chatdinger/blob/bc9d96e9331d9365185e04b735dbe944616f9dfb/LICENSE

MIT License

Copyright (c) 2025-2026 Rumble Lab and Chat Dinger contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Build dependencies

DoneBell has no npm runtime dependencies. esbuild (MIT), TypeScript
(Apache-2.0), and the type definitions (MIT) are development dependencies;
their packages and license files remain in node_modules and are not shipped
in the extension. esbuild legal comments are preserved when bundling.

## Audio and artwork

Original Chime is synthesized by DoneBell's Web Audio code. The bell icon in
assets/icons/icon.svg was created for DoneBell. No Chat Dinger sounds, logos,
or other artwork are bundled.

Optional local audio in assets/sounds/ is user-provided,
excluded from Git and public release builds, and not licensed by this notice
or by DoneBell's MIT License. The local catalog is also excluded from the public
repository and release builds. Imported audio remains local
and subject to its own rights.

## DoneBell license

DoneBell's original code (including the synthesized Original Chime) and
project-created artwork are licensed under the MIT License in LICENSE.
Copyright (c) 2026 Faruk (xafm). Third-party and user-provided media are
excluded from that license. LICENSE and this notice, including Chat Dinger's
upstream MIT notice above, are included in both the repository and extension
distribution.
