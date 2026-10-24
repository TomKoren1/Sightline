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
  NetworkAcl: { label: "Network ACL", color: "#4f7f98", group: "network" },
  VpcPeeringConnection: { label: "VPC peering", color: "#5577aa", group: "network" },
  TransitGateway: { label: "Transit gateway", color: "#4d6f9f", group: "network" },
  VpcEndpoint: { label: "VPC endpoint", color: "#6a93b8", group: "network" },
  VpcEndpointService: { label: "PrivateLink service", color: "#6488ad", group: "network" },
  LoadBalancer: { label: "Load balancer", color: "#7aa3c9", group: "network" },
  TargetGroup: { label: "Target group", color: "#5f8db0", group: "network" },
  CloudFrontDistribution: { label: "CloudFront", color: "#8fb3d9", group: "network" },
  ApiGateway: { label: "API Gateway", color: "#c9a04f", group: "compute" },
  HostedZone: { label: "Route 53 zone", color: "#6f8fb5", group: "network" },
  AutoScalingGroup: { label: "Auto Scaling group", color: "#c4914a", group: "compute" },
  EcsCluster: { label: "ECS cluster", color: "#b98a4a", group: "compute" },
  EcsService: { label: "ECS service", color: "#d1974f", group: "compute" },
  EksCluster: { label: "EKS cluster", color: "#c2873f", group: "compute" },
  EksNodeGroup: { label: "EKS node group", color: "#b67f3b", group: "compute" },
  SqsQueue: { label: "SQS queue", color: "#5fa88f", group: "data" },
  SnsTopic: { label: "SNS topic", color: "#56a083", group: "data" },
  KmsKey: { label: "KMS key", color: "#8a7fc0", group: "identity" },
  Secret: { label: "Secret", color: "#957ac7", group: "identity" },
  DynamoTable: { label: "DynamoDB table", color: "#4f9fa8", group: "data" },
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
  IamGroup: { label: "IAM group", color: "#946bbd", group: "identity" },
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

/** How a person names a kind: "EC2 instance", not "Ec2Instance". */
export const kindLabel = (kind: string): string => KIND_STYLES[kind]?.label ?? kind;
