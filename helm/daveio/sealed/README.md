# `sealed/`

The two SealedSecrets this deployment needs, once you have generated them:

- `secrets.yaml` — database passwords, session key, Google credentials, the
  KMS key id, and the platform IAM user's access key.
- `cloudflared.yaml` — the tunnel token.

Deliberately **outside `templates/`**, so Helm never renders them and neither
is a file anyone would edit by hand. The commands that produce them are in
[../README.md](../README.md).

Only sealed output belongs here. A plaintext `Secret` in this directory is a
committed credential, and the repository's gitleaks job will fail the build
over it — as it has already done once, for a real Cloudflare tunnel token
pasted into the placeholder this directory replaced.

```bash
kubectl apply -n daveio -f helm/daveio/sealed/
```
