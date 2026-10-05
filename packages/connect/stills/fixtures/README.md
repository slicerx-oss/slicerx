# Fixtures

`high-1080p-idr.h264`: one H.264 key frame, Annex B with its SPS and PPS, High profile level 4.1, 1920x1080 (coded 1920x1088), the profile the Bambu Lab H2D camera sends. It is ffmpeg's `testsrc2` test pattern encoded with `-c:v libx264 -profile:v high -level 4.1 -crf 38 -x264-params keyint=1`, with its SEI unit removed. A generated pattern, no camera picture.
