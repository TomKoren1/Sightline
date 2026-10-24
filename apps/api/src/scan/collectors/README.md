# Collectors

<!-- Generated from registry.ts by `npm run gen:collectors -w @sightline/api`. Do not edit. -->

Each AWS service Sightline reads, what it produces, and every action it calls.
The read-only role template grants exactly these actions, generated from the
same registry, so a collector cannot gain a call the template does not grant.

| Service | Scope | Resource kinds | Relationships | Calls at most | Actions |
| ------- | ----- | -------------- | ------------- | ------------- | ------- |
| `apigateway` | regional | ApiGateway | IN_REGION, INTEGRATES_WITH | 2 + 2/resource | `apigateway:GET` |
| `autoscaling` | regional | AutoScalingGroup | IN_REGION, MANAGES | 1 + 0.01/resource | `autoscaling:DescribeAutoScalingGroups` |
| `cloudfront` | global | CloudFrontDistribution | none | 1 + 0.01/resource | `cloudfront:ListDistributions` |
| `dynamodb` | regional | DynamoTable | IN_REGION | 1 + 2/resource | `dynamodb:ListTables`, `dynamodb:DescribeTable`, `dynamodb:DescribeContinuousBackups` |
| `ec2` | regional | Ec2Instance, EbsVolume, ElasticIp | ATTACHED_TO, HAS_INSTANCE_PROFILE, HAS_SECURITY_GROUP, IN_REGION, IN_SUBNET | 3 + 0.01/resource | `ec2:DescribeInstances`, `ec2:DescribeVolumes`, `ec2:DescribeAddresses` |
| `ecs` | regional | EcsCluster, EcsService | EXECUTES_AS, HAS_SECURITY_GROUP, IN_CLUSTER, IN_REGION, IN_SUBNET, TARGETS | 1 + 2/resource | `ecs:ListClusters`, `ecs:ListServices`, `ecs:DescribeServices`, `ecs:DescribeTaskDefinition` |
| `eks` | regional | EksCluster, EksNodeGroup | CAN_ASSUME, EXECUTES_AS, IN_CLUSTER, IN_REGION, IN_SUBNET | 1 + 3/resource | `eks:ListClusters`, `eks:DescribeCluster`, `eks:ListNodegroups`, `eks:DescribeNodegroup`, `eks:ListPodIdentityAssociations`, `eks:DescribePodIdentityAssociation` |
| `elbv2` | regional | LoadBalancer, TargetGroup | FORWARDS_TO, HAS_SECURITY_GROUP, IN_REGION, IN_SUBNET, TARGETS | 2 + 1/resource | `elasticloadbalancing:DescribeLoadBalancers`, `elasticloadbalancing:DescribeListeners`, `elasticloadbalancing:DescribeTargetGroups`, `elasticloadbalancing:DescribeTargetHealth` |
| `iam` | global | IamRole, IamUser, IamGroup, IamPolicy, InstanceProfile | HAS_POLICY, MEMBER_OF, PROVIDES_ROLE | 5 + 0.01/resource | `iam:GetAccountAuthorizationDetails`, `iam:ListRoles`, `iam:ListUsers`, `iam:GetPolicy`, `iam:GetPolicyVersion` |
| `kms` | regional | KmsKey | IN_REGION | 1 + 3/resource | `kms:ListKeys`, `kms:DescribeKey`, `kms:GetKeyPolicy`, `kms:GetKeyRotationStatus` |
| `lambda` | regional | LambdaFunction | EXECUTES_AS, HAS_SECURITY_GROUP, IN_REGION, IN_SUBNET | 1 + 0.02/resource | `lambda:ListFunctions` |
| `rds` | regional | RdsInstance, DbSubnetGroup | HAS_SECURITY_GROUP, IN_REGION, IN_SUBNET, USES_SUBNET_GROUP | 2 + 0.01/resource | `rds:DescribeDBInstances`, `rds:DescribeDBSubnetGroups` |
| `route53` | global | HostedZone | none | 1 + 1/resource | `route53:ListHostedZones`, `route53:ListResourceRecordSets` |
| `s3` | global | S3Bucket | IN_REGION | 1 + 6/resource | `s3:ListAllMyBuckets`, `s3:GetBucketLocation`, `s3:GetBucketPolicy`, `s3:GetBucketPolicyStatus`, `s3:GetBucketPublicAccessBlock`, `s3:GetBucketAcl`, `s3:GetBucketTagging` |
| `secretsmanager` | regional | Secret | IN_REGION | 1 + 1/resource | `secretsmanager:ListSecrets`, `secretsmanager:GetResourcePolicy` |
| `sns` | regional | SnsTopic | IN_REGION | 1 + 1/resource | `sns:ListTopics`, `sns:GetTopicAttributes` |
| `sqs` | regional | SqsQueue | IN_REGION | 1 + 1/resource | `sqs:ListQueues`, `sqs:GetQueueAttributes` |
| `vpc` | regional | Vpc, Subnet, SecurityGroup, InternetGateway, NatGateway, RouteTable, NetworkAcl, VpcPeeringConnection, TransitGateway, VpcEndpoint, VpcEndpointService | ATTACHED_TO, CONNECTS_TO, HAS_NACL, HAS_SECURITY_GROUP, IN_REGION, IN_SUBNET, IN_VPC, PEERS_WITH, ROUTES_TO, SERVED_BY, USES_ROUTE_TABLE | 14 + 0.05/resource | `ec2:DescribeVpcs`, `ec2:DescribeSubnets`, `ec2:DescribeSecurityGroups`, `ec2:DescribeInternetGateways`, `ec2:DescribeNatGateways`, `ec2:DescribeRouteTables`, `ec2:DescribeNetworkAcls`, `ec2:DescribeVpcPeeringConnections`, `ec2:DescribeTransitGateways`, `ec2:DescribeTransitGatewayAttachments`, `ec2:DescribeTransitGatewayRouteTables`, `ec2:SearchTransitGatewayRoutes`, `ec2:DescribeVpcEndpoints`, `ec2:DescribeVpcEndpointServiceConfigurations` |

64 actions across 18 services.

## Adding a service

1. Write the collector in this directory: `(ctx) => { resources, relationships }`.
2. Add its entry to `registry.ts`: scope, the kinds and relationships it emits, its
   call budget, and the actions it calls.
3. Add the service id to `SCANNABLE_SERVICES` in `packages/shared`.
4. With moto running, run `npm run gen:fixtures`, which seeds it and records the
   fixtures, and commit what it changes. `contract.test.ts` then holds the collector to its
   entry against moto, and the fixture lets every analyser test run without it.
