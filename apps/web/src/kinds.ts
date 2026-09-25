/**
 * Presentation metadata per resource kind.
 *
 * Colour carries meaning rather than decoration: the network substrate is
 * muted, compute and data are distinct, and identity stands apart because IAM
 * findings are usually the ones that matter most.
 */
export interface KindStyle {
  label: string;
  color: string;
  group: "identity" | "compute" | "data" | "network" | "meta";
}

export const KIND_STYLES: Record<string, KindStyle> = {
  Account: { label: "Account", color: "#8b95a8", group: "meta" },
  Region: { label: "Region", color: "#6b7689", group: "meta" },
  Internet: { label: "Internet", color: "#ff6b6b", group: "meta" },
  Vpc: { label: "VPC", color: "#4a6fa5", group: "network" },
  Subnet: { label: "Subnet", color: "#3f7fa8", group: "network" },
  SecurityGroup: { label: "Security group", color: "#5a8fa8", group: "network" },
  RouteTable: { label: "Route table", color: "#456b80", group: "network" },
  InternetGateway: { label: "Internet gateway", color: "#6a8fb5", group: "network" },
  NatGateway: { label: "NAT gateway", color: "#5a7f95", group: "network" },
  ElasticIp: { label: "Elastic IP", color: "#6b8fa0", group: "network" },
  Ec2Instance: { label: "EC2 instance", color: "#c98a3f", group: "compute" },
  LambdaFunction: { label: "Lambda", color: "#d4a04f", group: "compute" },
  EbsVolume: { label: "EBS volume", color: "#9a8f6f", group: "data" },
  S3Bucket: { label: "S3 bucket", color: "#4fa87a", group: "data" },
  RdsInstance: { label: "RDS instance", color: "#4f8fa8", group: "data" },
  DbSubnetGroup: { label: "DB subnet group", color: "#4a7f90", group: "data" },
  IamRole: { label: "IAM role", color: "#a87fd4", group: "identity" },
  IamUser: { label: "IAM user", color: "#9a6fc4", group: "identity" },
  IamPolicy: { label: "IAM policy", color: "#8f6fb5", group: "identity" },
  InstanceProfile: { label: "Instance profile", color: "#9f7fc9", group: "identity" },
};

export const styleFor = (kind: string): KindStyle =>
  KIND_STYLES[kind] ?? { label: kind, color: "#6b7689", group: "meta" };

/**
 * Kinds shown by default.
 *
 * Route tables and subnets triple the node count while adding little to a
 * first look, so they start hidden and can be switched on. The graph should
 * open on something readable, not on everything.
 */
export const DEFAULT_VISIBLE_KINDS = Object.keys(KIND_STYLES).filter(
  (k) => k !== "RouteTable" && k !== "DbSubnetGroup" && k !== "IamPolicy",
);
