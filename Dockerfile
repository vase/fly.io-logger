FROM hayd/distroless-deno:1.9.0@sha256:470563bfd23190d42cd9915c30c91210c4dce5aeff361aaa2060215a9d1a775e
ENV DENO_ENV=production

WORKDIR /app
USER nonroot
COPY main.ts deps.* ./
RUN /bin/bash -c "deno cache deps.ts || true"
ADD . .
RUN deno cache main.ts

CMD ["run", "--allow-net", "--allow-env", "main.ts"]