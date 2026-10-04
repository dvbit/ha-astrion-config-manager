#!/usr/bin/with-contenv bashio
# Start Astrion Config Manager. /data is the persistent volume (spec RNF2).
export ACM_LOG_LEVEL="$(bashio::config 'log_level')"
export ACM_DATA_DIR=/data
bashio::log.info "Starting Astrion Config Manager (log level: ${ACM_LOG_LEVEL})"
cd /app || exit 1
exec python3 -m acm
