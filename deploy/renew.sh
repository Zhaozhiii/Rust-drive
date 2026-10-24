#!/bin/sh
set -eu
docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v /var/lib/letsencrypt:/var/lib/letsencrypt -v /var/log/letsencrypt:/var/log/letsencrypt -v /root/blogweb/acme:/var/www/acme certbot/certbot@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20 renew --quiet "$@"
docker exec blogweb-nginx nginx -t
docker exec blogweb-nginx nginx -s reload
