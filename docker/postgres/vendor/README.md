# Vendored sources for the database image

Put the pinned tarballs here to build `docker/postgres/Dockerfile` on a host that cannot reach github.com. The
Dockerfile prefers a file in this directory over any download and still verifies its SHA-256, so an unverified or
truncated file fails the build instead of reaching the image.

Name each file after its checksum, exactly as the Dockerfile pins it:

| File | What it is |
|---|---|
| `c4f83883bf453aa9829a36abea76a11d546016fe639838b72b66bfca9f7f4d0d.tar.gz` | SCWS `a04ef5e655213eb6b07fb57761d0eac72c281ad4` |
| `ce5d5e21a1c1f8b3f466998fba0efe51928aad6e12026b5e30ecd2afbfa3285e.tar.gz` | zhparser `2e995c4df672563992b4d7a147b8fa2d0d4cda6c` |

`*.tar.gz` is ignored by Git: the tarballs are build inputs, not part of the tree. Fetch them somewhere with access
(for example `curl -fsSL -o <sha256>.tar.gz https://github.com/hightman/scws/archive/<commit>.tar.gz`) and copy them
in. Alternatively pass `--build-arg SCWS_URL=…` and `--build-arg ZHPARSER_URL=…` at a mirror and leave this directory
empty.
