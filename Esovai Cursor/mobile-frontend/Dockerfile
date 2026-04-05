FROM nginx:alpine

ARG ALLOWED_TOKEN
RUN test -n "$ALLOWED_TOKEN" || (echo "ALLOWED_TOKEN required" && exit 1)

COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN sed -i "s/NGINX_TOKEN_PLACEHOLDER/${ALLOWED_TOKEN}/g" /etc/nginx/conf.d/default.conf

COPY public/ /usr/share/nginx/html/

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
