FROM hayd/alpine-deno:1.9.0@sha256:7e5e9f019df8553bf96bfd46dfa13da9ec252b41cc8136f39ab86a432d11eca5
ENV DENO_ENV production
WORKDIR /app

# Cache the dependencies as a layer (the following two steps are re-run only when deps.ts is modified).
# Ideally fetch deps.ts will download and compile _all_ external files used in main.ts.
COPY deps.ts .
RUN ["deno", "cache", "deps.ts"]

# These steps will be re-run upon each file change in your working directory:
ADD . .
# Compile the main app so that it doesn't need to be compiled each startup/entry.
RUN ["deno", "cache", "main.ts"]

# Optionally prefer not to run as root.
USER deno

CMD ["run", "--allow-net", "--allow-env", "main.ts"]