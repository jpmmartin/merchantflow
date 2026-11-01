FROM node:26.13.0-trixie-slim

# Corepack is not distributed with Node.js 26, so pnpm is installed explicitly.
RUN npm install --global pnpm@12.16.1

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Directories are created before the volumes mount over them so that the
# named volumes inherit ownership by the unprivileged node user.
RUN mkdir -p /workspace/node_modules /pnpm/store \
    && chown -R node:node /workspace /pnpm

WORKDIR /workspace

# Explicit paths only: docs/ and local agent configuration never enter the image.
COPY --chown=node:node package.json pnpm-workspace.yaml tsconfig.base.json ./

USER node
