# Agent Security Guidelines

Security rules that **must** be followed when adding or modifying dependencies, pipelines, and infrastructure. No exceptions without explicit human approval.

---

## 1. Dependency Pinning

All external dependencies must be pinned to an **immutable, content-addressed identifier**. Tags, version ranges, and `latest` are forbidden.

### Docker images
```dockerfile
# WRONG
FROM node:20
FROM alpine:latest
FROM mcr.microsoft.com/dotnet/aspnet:9.0

# CORRECT — pin to digest
FROM node@sha256:<digest>
FROM alpine@sha256:<digest>
FROM mcr.microsoft.com/dotnet/aspnet@sha256:<digest>
```
To get a digest: `docker pull <image>:<tag>` then `docker inspect --format='{{index .RepoDigests 0}}' <image>:<tag>`

### Docker Compose / Kubernetes
Same rule. Never use `image: mongo:7`, always `image: mongo@sha256:<digest>`.

### GitHub Actions
```yaml
# WRONG
uses: actions/checkout@v4
uses: actions/setup-node@v4

# CORRECT — pin to commit SHA, tag in comment for readability
uses: actions/checkout@<sha> # v4
uses: actions/setup-node@<sha> # v4
```
To get the SHA: `gh api /repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha`  
If the tag is annotated, dereference: `gh api /repos/<owner>/<repo>/git/tags/<sha> --jq .object.sha`

### npm / pnpm / yarn
```json
// WRONG — ranges are mutable
"express": "^4.18.0"

// CORRECT — exact versions + lockfile committed
"express": "4.18.2"
```
Always commit `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`. Never run installs without `--frozen-lockfile` / `npm ci` in CI.

### NuGet
```xml
<!-- WRONG -->
<PackageReference Include="Newtonsoft.Json" Version="13.*" />

<!-- CORRECT — exact version + lock file -->
<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
```
Enable lock files in `Directory.Build.props`:
```xml
<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
```
Use `--locked-mode` in CI and Dockerfiles. Commit all `packages.lock.json` files.

### Python (pip)
```txt
# WRONG
requests>=2.28

# CORRECT — exact version + hash pinning
requests==2.31.0 --hash=sha256:<hash>
```
Generate with `pip-compile --generate-hashes`.

---

## 2. Secrets Handling

- **Never** hardcode secrets, tokens, passwords, or API keys in source files, Dockerfiles, or CI config.
- **Never** pass secrets as environment variables when a secrets manager or mounted secret file is available (e.g. Docker secrets, Kubernetes secrets mounted as files).
- **Never** log secrets. Treat any header named `Authorization`, `X-*-Secret`, `X-*-Key`, `X-*-Token`, or `Password` as sensitive — mask or omit from logs.
- Secrets that change independently of code (e.g. SMTP credentials, API keys) must be stored outside the repository and injected at runtime. Rotating them must **not** require a code change or pipeline trigger.
- CI/CD secrets (e.g. GitHub Actions secrets) should be **scoped as narrowly as possible** and reviewed when pipeline steps change. Delete any secret that is no longer referenced.

---

## 3. CI/CD Pipeline Hardening

- Set **least-privilege permissions** on every workflow. Declare `permissions:` explicitly; default to `contents: read` and add only what each job actually needs.
- Do not use `runs-on: self-hosted` unless the runner is hardened and isolated.
- Never use `pull_request_target` without careful review — it runs with write permissions against external PRs.
- Avoid `workflow_dispatch` inputs that are interpolated directly into shell commands (injection risk).
- Do not `curl | bash` or pipe remote content into a shell in any pipeline step.

---

## 4. Container & Infrastructure Security

- Containers must run as a **non-root user**. Create a dedicated user in the Dockerfile; use `USER` before `CMD`/`ENTRYPOINT`.
- Do not bind container ports to `0.0.0.0` unless the port must be publicly reachable. Prefer `127.0.0.1:<host>:<container>`.
- Do not mount the Docker socket (`/var/run/docker.sock`) into containers unless absolutely required.
- Cron jobs and scheduled tasks must run as the **least-privileged user** that can perform the operation — never as `root`.
- Use multi-stage Docker builds to keep build tooling out of final images.

---

## 5. Updating Pinned Dependencies

When a dependency must be updated:
1. Obtain the new immutable identifier (digest/SHA/exact version).
2. Update the pin.
3. Regenerate lockfiles if applicable.
4. Commit pin + lockfile together in the same change.

Do **not** bump a pin without verifying the new version/digest against the official release (check release notes, compare digests from the official registry or package index).
