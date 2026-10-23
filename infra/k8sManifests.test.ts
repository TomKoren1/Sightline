/**
 * Guards on the Kubernetes manifests, which nothing in this repository runs.
 *
 * The same reasoning as `infra/template.test.ts`: these files are applied by a
 * human against a cluster, so no test exercises them, so the only things that
 * catch a mistake are a careful reader and a bad afternoon. The three checks
 * below are the ones where being wrong is *silent* - the manifests apply
 * cleanly, the pods start, and something is quietly not true.
 *
 * Deliberately not a schema check. `kubectl apply --dry-run=server` validates
 * shapes against a real API server far better than any assertion here could,
 * and it is in the README. What that cannot tell you is whether two files
 * agree with each other.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments, parse } from "yaml";

import { hostedInvariantViolations, type Env } from "../apps/api/src/hostedMode.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(`${root}deploy/k8s/${p}`, "utf8");

interface Manifest {
  kind?: string;
  metadata?: { name?: string };
  spec?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Every document in every manifest file, base and overlay. */
function manifests(): Manifest[] {
  const files = [
    "base/datastores.yaml",
    "base/app.yaml",
    "base/networkpolicy.yaml",
    "base/backup.yaml",
    "prod/cloudflared.yaml",
    "prod/namespace.yaml",
    "staging/namespace.yaml",
  ];
  return files.flatMap((f) =>
    parseAllDocuments(read(f))
      .map((doc): Manifest | null => doc.toJS() as Manifest | null)
      .filter((doc): doc is Manifest => doc !== null && Object.keys(doc).length > 0),
  );
}

/** The non-secret configuration, which `configMapGenerator` holds. */
function configLiterals(): Env {
  const kustomization = parse(read("base/kustomization.yaml")) as {
    configMapGenerator?: { name: string; literals?: string[] }[];
  };
  const generator = kustomization.configMapGenerator?.find((g) => g.name === "sightline-config");
  expect(generator, "base/kustomization.yaml no longer generates sightline-config").toBeTruthy();
  return Object.fromEntries(
    (generator!.literals ?? []).map((l) => {
      const at = l.indexOf("=");
      return [l.slice(0, at), l.slice(at + 1)];
    }),
  );
}

interface PodSpec {
  containers?: {
    name?: string;
    env?: { name: string; value?: string }[];
    envFrom?: { configMapRef?: { name: string }; secretRef?: { name: string } }[];
    resources?: { limits?: Record<string, string>; requests?: Record<string, string> };
  }[];
}

/** Workloads and the pod template they run, whatever kind they are. */
function workloads(): { kind: string; name: string; replicas: number; pod: PodSpec }[] {
  return manifests()
    .filter((m) => ["Deployment", "StatefulSet", "Job"].includes(m.kind ?? ""))
    .map((m) => {
      const spec = m.spec as {
        replicas?: number;
        template?: { metadata?: { labels?: Record<string, string> }; spec?: PodSpec };
      };
      return {
        kind: m.kind!,
        name:
          spec.template?.metadata?.labels?.["app.kubernetes.io/name"] ??
          m.metadata?.name ??
          "unnamed",
        // A Job and a one-replica Deployment both run one pod.
        replicas: spec.replicas ?? 1,
        pod: spec.template?.spec ?? {},
      };
    });
}

describe("the Kubernetes manifests", () => {
  it("were found and parsed", () => {
    // Without this every assertion below passes on an empty list, which is how
    // a guard over files it does not run quietly stops guarding.
    expect(manifests().length).toBeGreaterThan(15);
    expect(workloads().length).toBeGreaterThan(4);
  });

  it("contain no credential of any kind", () => {
    /**
     * The one mistake in this directory that cannot be taken back: this
     * repository is public, and a committed Secret is a published Secret even
     * after it is deleted.
     *
     * `SealedSecret` is the accepted form - encrypted to the cluster's
     * controller key and useless to anyone else - so this refuses a plain
     * `kind: Secret` with values, and refuses the `secretGenerator` that would
     * read one from a file beside it.
     */
    const plaintext = manifests()
      .filter((m) => m.kind === "Secret")
      .map((m) => m.metadata?.name ?? "unnamed");
    expect(
      plaintext,
      "a plain Secret in these manifests is a credential in a public repository. Seal it with " +
        "`kubeseal` instead; deploy/k8s/README.md has the commands.",
    ).toEqual([]);

    /**
     * Parsed, not grepped. The first version matched the string anywhere in the
     * file and fired on `prod/kustomization.yaml`, whose comment *explains* why
     * `secretGenerator` is not used - a guard that trips on the prose
     * describing the rule is a guard somebody deletes.
     */
    const generators = [
      "base/kustomization.yaml",
      "prod/kustomization.yaml",
      "staging/kustomization.yaml",
    ].filter((f) => {
      const k = parse(read(f)) as { secretGenerator?: unknown[] };
      return (k.secretGenerator?.length ?? 0) > 0;
    });
    expect(
      generators,
      "`secretGenerator` builds a Secret from a local file, which is one `git add -A` away from " +
        "being committed. Use a SealedSecret.",
    ).toEqual([]);
  });

  it("does not configure a hosted deployment the API would refuse to start", () => {
    /**
     * Checked with the application's **own** invariant function, not a copy of
     * its rules. Every one of those rules refuses a configuration that produces
     * a working system with a silently wrong security property - so a manifest
     * that tripped one would deploy, roll, and leave every pod in CrashLoopBackOff
     * with the reason only in a log.
     *
     * Only the ConfigMap is available here: the rest comes from a SealedSecret
     * that deliberately is not in this repository. So the keys that live in the
     * secret are supplied as placeholders, and what this really asserts is that
     * the *non-secret* half contradicts nothing.
     */
    const fromSecret: Env = {
      DATABASE_URL: "postgres://owner@postgres:5432/sightline",
      DATABASE_URL_APP: "postgres://sightline_app@postgres:5432/sightline",
      SESSION_SECRET: "s".repeat(48),
      PUBLIC_BASE_URL: "https://sightline.example.com",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      AWS_KMS_KEY_ID: "arn:aws:kms:us-east-1:111111111111:key/placeholder",
      SCANNER_PRINCIPAL_ARN: "arn:aws:iam::111111111111:user/SightlineScanner",
      ROLE_TEMPLATE_URL: "https://example.invalid/readonly-role.yaml",
    };

    expect(hostedInvariantViolations({ ...fromSecret, ...configLiterals() })).toEqual([]);
  });

  it("runs the datastores' own migrations from one place only", () => {
    const config = configLiterals();
    // Two replicas racing to apply the same migration is the problem the
    // migrate Job exists to solve; leaving this on would reintroduce it while
    // the Job sat there looking like the answer.
    expect(config["MIGRATE_ON_BOOT"]).toBe("false");

    const api = workloads().find((w) => w.name === "api");
    expect(api, "no api workload").toBeTruthy();
    expect(api!.replicas).toBeGreaterThan(1);

    const migrate = workloads().find((w) => w.name === "migrate");
    expect(migrate, "nothing applies migrations, so the API will refuse to start").toBeTruthy();
    expect(migrate!.kind).toBe("Job");
  });

  it("lets everything that holds a database URL actually reach the database", () => {
    /**
     * A cross-artefact agreement with no other link between the two files.
     *
     * `networkpolicy.yaml` names the pods allowed to connect to Postgres. A
     * workload given `sightline-app` - which carries `DATABASE_URL` -
     * clearly intends to connect, so if it is missing from that list it is
     * denied, and the symptom is a connection timeout rather than anything
     * saying "policy". Derived from the manifests rather than listed here, so a
     * workload added later is covered without anybody remembering.
     */
    const needsDatabase = workloads()
      .filter((w) =>
        (w.pod.containers ?? []).some((c) =>
          (c.envFrom ?? []).some((f) => f.secretRef?.name === "sightline-app"),
        ),
      )
      .map((w) => w.name);
    expect(needsDatabase.length).toBeGreaterThan(2);

    const policy = manifests().find(
      (m) => m.kind === "NetworkPolicy" && m.metadata?.name === "datastores-from-app-only",
    );
    expect(policy, "the datastore policy is gone").toBeTruthy();

    const allowed = new Set(
      (
        policy!.spec as {
          ingress?: {
            from?: {
              podSelector?: { matchExpressions?: { key: string; values?: string[] }[] };
            }[];
          }[];
        }
      ).ingress
        ?.flatMap((rule) => rule.from ?? [])
        .flatMap((from) => from.podSelector?.matchExpressions ?? [])
        .filter((e) => e.key === "app.kubernetes.io/name")
        .flatMap((e) => e.values ?? []),
    );

    const denied = needsDatabase.filter((name) => !allowed.has(name));
    expect(
      denied,
      "these workloads are given DATABASE_URL but are not allowed to reach Postgres by " +
        "`datastores-from-app-only`, so every connection they make will time out. Add them to " +
        "the policy's values, or stop giving them the secret.",
    ).toEqual([]);
  });
});

describe("the staging overlay", () => {
  interface Kustomization {
    namespace?: string;
    images?: { name: string; newTag?: string }[];
    patches?: { target?: { kind?: string; name?: string }; patch?: string }[];
  }
  const staging = () => parse(read("staging/kustomization.yaml")) as Kustomization;
  const prod = () => parse(read("prod/kustomization.yaml")) as Kustomization;
  const tags = (k: Kustomization) => new Map(k.images?.map((i) => [i.name, i.newTag]));

  it("cannot touch prod's objects", () => {
    // A shared namespace would share the secrets, the volume and the Services.
    expect(staging().namespace).toBeTruthy();
    expect(staging().namespace).not.toBe(prod().namespace);
  });

  it("runs images of its own, so importing a staging build cannot roll prod", () => {
    // Prod takes its tags from the base; staging must override every one.
    const base = tags(parse(read("base/kustomization.yaml")) as Kustomization);
    const own = tags(staging());
    for (const [image, tag] of base) {
      expect(own.get(image), `staging runs ${image}:${tag}, which is prod's tag`).toBeTruthy();
      expect(own.get(image)).not.toBe(tag);
    }
  });

  it("drops what would duplicate prod's: backups, and the dashboards Grafana reads everywhere", () => {
    const deleted = (staging().patches ?? [])
      .filter((p) => p.patch?.includes("$patch: delete"))
      .map((p) => `${p.target?.kind}/${p.target?.name ?? "*"}`);
    expect(deleted).toEqual(
      expect.arrayContaining([
        "CronJob/postgres-backup",
        "ConfigMap/sightline-dashboards",
        "PodDisruptionBudget/*",
      ]),
    );
  });
});
