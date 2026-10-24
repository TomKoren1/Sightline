/**
 * Which AWS FSBP controls and CIS AWS Foundations requirements a finding bears on.
 *
 * Buyers report against named controls, so a finding that says "IAM.1" is one
 * they can file. Only controls whose check matches what the finding detects:
 * an unused role has none, and none is invented for it. FSBP ids and titles
 * are from the AWS Security Hub FSBP standard (v1.0.0) control list. A CIS
 * requirement is listed only where the Security Hub control's own "Related
 * requirements" names it, newest benchmark version first; its title and link
 * are that control's, since the benchmark text is CIS's to publish. Both read
 * at https://docs.aws.amazon.com/securityhub/latest/userguide/ in October 2026.
 */

export interface Control {
  framework: "AWS FSBP" | "CIS AWS Foundations";
  id: string;
  /** For CIS: the benchmark version the id is from. */
  version?: string;
  /** How a findings row names it: "FSBP IAM.1", "CIS 2.1.4". */
  label: string;
  title: string;
  url: string;
}

const DOCS = "https://docs.aws.amazon.com/securityhub/latest/userguide";

const control = (id: string, title: string, page: string): Control => ({
  framework: "AWS FSBP",
  id,
  label: `FSBP ${id}`,
  title,
  url: `${DOCS}/${page}-controls.html#${id.toLowerCase().replace(".", "-")}`,
});

/** A CIS requirement, by the Security Hub control that checks it. */
const cis = (id: string, version: string, via: Pick<Control, "title" | "url">): Control => ({
  framework: "CIS AWS Foundations",
  id,
  version,
  label: `CIS ${id}`,
  title: `${via.title} (CIS AWS Foundations Benchmark v${version})`,
  url: via.url,
});

const C = {
  ec2_4: control(
    "EC2.4",
    "Stopped EC2 instances should be removed after a specified time period",
    "ec2",
  ),
  ec2_18: control(
    "EC2.18",
    "Security groups should only allow unrestricted incoming traffic for authorized ports",
    "ec2",
  ),
  eks_1: control("EKS.1", "EKS cluster endpoints should not be publicly accessible", "eks"),
  iam_1: control(
    "IAM.1",
    'IAM policies should not allow full "*" administrative privileges',
    "iam",
  ),
  iam_8: control("IAM.8", "Unused IAM user credentials should be removed", "iam"),
  kms_5: control("KMS.5", "KMS keys should not be publicly accessible", "kms"),
  lambda_1: control("Lambda.1", "Lambda function policies should prohibit public access", "lambda"),
  rds_2: control(
    "RDS.2",
    "RDS DB Instances should prohibit public access, as determined by the PubliclyAccessible configuration",
    "rds",
  ),
  s3_2: control("S3.2", "S3 general purpose buckets should block public read access", "s3"),
  s3_8: control("S3.8", "S3 general purpose buckets should block public access", "s3"),
  sns_4: control("SNS.4", "SNS topic access policies should not allow public access", "sns"),
  sqs_3: control("SQS.3", "SQS queue access policies should not allow public access", "sqs"),
};

/** IAM.22 is not in FSBP; it is how Security Hub checks CIS's unused-credentials rule. */
const IAM_22 = {
  title: "IAM user credentials unused for 45 days should be removed",
  url: `${DOCS}/iam-controls.html#iam-22`,
};

const CIS = {
  /** Via IAM.1: dropped from the benchmark after v1.4.0. */
  admin: cis("1.16", "1.4.0", C.iam_1),
  /** Via IAM.22. Users are flagged after 90 days, so they fail its 45 as well. */
  unusedUser: cis("1.11", "5.0.0", IAM_22),
  /** Via RDS.2. */
  publicRds: cis("2.2.3", "5.0.0", C.rds_2),
  /** Via S3.8. */
  bucketBlock: cis("2.1.4", "5.0.0", C.s3_8),
};

const EXPOSED: Partial<Record<string, Control[]>> = {
  S3Bucket: [C.s3_2],
  RdsInstance: [C.rds_2, CIS.publicRds],
  LambdaFunction: [C.lambda_1],
  SqsQueue: [C.sqs_3],
  SnsTopic: [C.sns_4],
  KmsKey: [C.kms_5],
  EksCluster: [C.eks_1],
  Ec2Instance: [C.ec2_18],
};

export type FrameworkCategory = "exposed" | "admin" | "idle" | "unguarded" | "unused";

export function controlsFor(category: FrameworkCategory, kind: string): Control[] {
  switch (category) {
    case "exposed":
      return EXPOSED[kind] ?? [];
    case "admin":
      return kind === "IamRole" || kind === "IamUser" ? [C.iam_1, CIS.admin] : [];
    case "unguarded":
      return kind === "S3Bucket" ? [C.s3_8, CIS.bucketBlock] : [];
    case "unused":
      return kind === "IamUser" ? [C.iam_8, CIS.unusedUser] : [];
    case "idle":
      return kind === "Ec2Instance" ? [C.ec2_4] : [];
  }
}
