FROM nginx:alpine

ARG ALLOWED_TOKEN=changeme

COPY nginx.conf /etc/nginx/conf.d/default.conf
# Token-Placeholder ersetzen (Token bleibt aus .env, nicht im Git)
RUN sed -i "s|ALLOWED_TOKEN_PLACEHOLDER|${ALLOWED_TOKEN}|g" /etc/nginx/conf.d/default.conf

COPY public /usr/share/nginx/html
