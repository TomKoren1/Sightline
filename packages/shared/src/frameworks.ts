/**
 * Which AWS Foundational Security Best Practices controls a finding bears on.
 *
 * Buyers report against named controls, so a finding that says "IAM.1" is one
 * they can file. Only controls whose check matches what the finding detects:
 * an unused role has no FSBP control, and none is invented for it. IDs and
 * titles are from the AWS Security Hub FSBP standard (v1.0.0) control list,
 * https://docs.aws.amazon.com/securityhub/latest/userguide/fsbp-standard.html
 * as of October 2026. CIS mappings are left out until checked the same way.
 */

export interface Control {
  framework: "AWS FSBP";
  id: string;
  title: string;
  url: string;
}

const DOCS = "https://docs.aws.amazon.com/securityhub/latest/userguide";

const control = (id: string, title: string, page: string): Control => ({
  framework: "AWS FSBP",
  id,
  title,
  url: `${DOCS}/${page}-controls.html#${id.toLowerCase().replace(".", "-")}`,
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

const EXPOSED: Partial<Record<string, Control[]>> = {
  S3Bucket: [C.s3_2],
  RdsInstance: [C.rds_2],
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
      return kind === "IamRole" || kind === "IamUser" ? [C.iam_1] : [];
    case "unguarded":
      return kind === "S3Bucket" ? [C.s3_8] : [];
    case "unused":
      return kind === "IamUser" ? [C.iam_8] : [];
    case "idle":
      return kind === "Ec2Instance" ? [C.ec2_4] : [];
  }
}
