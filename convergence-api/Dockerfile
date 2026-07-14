ARG BUILD_FROM
FROM ${BUILD_FROM:-ghcr.io/home-assistant/amd64-base:3.19}

RUN apk add --no-cache bash nodejs npm git jq

WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev

COPY server.js /app/
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
