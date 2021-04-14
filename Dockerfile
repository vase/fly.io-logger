FROM hayd/debian-deno:latest
ENV DENO_ENV=production

WORKDIR /app
USER deno
COPY main.ts deps.* ./
RUN /bin/bash -c "deno cache deps.ts || true"
ADD . .
RUN deno cache main.ts

CMD ["run", "--allow-net", "--allow-env", "main.ts"]