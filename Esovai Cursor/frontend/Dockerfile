FROM nginx:alpine

# Token wird als Build-Arg übergeben und in nginx.conf eingebettet.
# docker-compose übergibt: --build-arg ALLOWED_TOKEN=<wert aus .env>
ARG ALLOWED_TOKEN

COPY nginx.conf /etc/nginx/conf.d/default.conf

# Token-Placeholder ersetzen (nur diesen, nginx-Variablen wie $host bleiben)
RUN sed -i "s|NGINX_TOKEN_PLACEHOLDER|${ALLOWED_TOKEN}|g" /etc/nginx/conf.d/default.conf

COPY public /usr/share/nginx/html
