ARG BUILD_FROM
FROM ${BUILD_FROM:-ghcr.io/home-assistant/amd64-base:3.19}

RUN apk add --no-cache bash nodejs npm git jq

WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev

COPY server.js chat.html render.js addressing.js auth.js /app/
COPY run.sh /run.sh
# Belt-and-suspenders for issue #34: `.gitattributes` (`*.sh text eol=lf`) is
# the real fix — it guarantees `run.sh` is always checked out with LF, on any
# platform, before this COPY ever runs. This `sed` strips any CRLF that could
# still slip in (e.g. a build context assembled some other way than
# `git checkout`), so a Windows checkout / editor accident can never again
# produce a `\r` in the shebang that makes s6 fail with
# `exec: fatal: unable to exec bash\r: No such file or directory` (exit 127,
# container reports state=started/cpu=0 with empty logs — never boots).
RUN sed -i 's/\r$//' /run.sh && chmod a+x /run.sh

CMD ["/run.sh"]
