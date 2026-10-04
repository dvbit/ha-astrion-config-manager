# Explicit, pinned base image (Supervisor >= 2026.04 no longer passes
# BUILD_FROM). Multi-arch image: aarch64 + amd64.
FROM ghcr.io/home-assistant/base-python:3.13-alpine3.23

# Python dependencies (aiohttp server/client, JSON Patch for delta history).
COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

# Application code and static panel.
COPY app /app
COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
