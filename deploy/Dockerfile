FROM scratch
COPY drive-service /drive-service
ENV DRIVE_LISTEN=0.0.0.0:3104 CLOUDDRIVE_ROOT=/data
USER 0
EXPOSE 3104
ENTRYPOINT ["/drive-service"]
