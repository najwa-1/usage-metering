FROM node:22-alpine
RUN apk add --no-cache bash
WORKDIR /perf
COPY package.json package-lock.json ./
RUN npm ci
COPY load-test.ts run-suite.sh ./
CMD ["bash", "run-suite.sh", "docker"]
