# Kubernetes example

A minimal Deployment and Service for the `timcinel/co-larger` image. The
container runs as a non-root user on port 8080 with a read-only root
filesystem; nginx needs a writable `/tmp` only. Replace the tag with the
commit tag (or digest) you want to run.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: co-larger
spec:
  replicas: 2
  selector:
    matchLabels: { app: co-larger }
  template:
    metadata:
      labels: { app: co-larger }
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 101
        runAsGroup: 101
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: co-larger
          image: docker.io/timcinel/co-larger:latest # pin a commit tag or digest
          ports:
            - name: http
              containerPort: 8080
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
          readinessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            initialDelaySeconds: 5
            periodSeconds: 30
          resources:
            requests: { cpu: 10m, memory: 32Mi }
            limits: { memory: 128Mi }
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: { medium: Memory, sizeLimit: 16Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: co-larger
spec:
  selector: { app: co-larger }
  ports:
    - name: http
      port: 80
      targetPort: http
```

Expose the Service through your ingress or reverse proxy. To serve it under a
sub-path, strip the prefix at the proxy (see the README).
