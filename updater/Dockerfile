FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG UPDATER_VERSION=1.1.0
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-X github.com/ComPDFKit/compdf-self-hosted/updater/internal/buildinfo.Version=${UPDATER_VERSION}" -o /out/compdfctl ./cmd/compdfctl \
    && CGO_ENABLED=0 go build -trimpath -ldflags "-X github.com/ComPDFKit/compdf-self-hosted/updater/internal/buildinfo.Version=${UPDATER_VERSION}" -o /out/compdf-updater ./cmd/compdf-updater

FROM python:3.13-alpine
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:29-cli /usr/local/bin/docker-compose /usr/local/bin/docker-compose
COPY --from=docker:29-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=build /out/compdfctl /out/compdf-updater /usr/local/bin/
COPY packaging/container.py /usr/local/lib/compdf-updater/container.py
WORKDIR /workspace
ENTRYPOINT ["python3", "/usr/local/lib/compdf-updater/container.py"]
