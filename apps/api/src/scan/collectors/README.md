# Collectors

<!-- Generated from registry.ts by `npm run gen:collectors -w @sightline/api`. Do not edit. -->

Each AWS service Sightline reads, what it produces, and every action it calls.
The read-only role template grants exactly these actions, generated from the
same registry, so a collector cannot gain a call the template does not grant.

| Service | Scope | Resource kinds | Actions |
| ------- | ----- | -------------- | ------- |
| `apigateway` | regional | ApiGateway | `apigateway:GET` |
| `autoscaling` | regional | AutoScalingGroup | `autoscaling:DescribeAutoScalingGroups` |
| `cloudfront` | global | CloudFrontDistribution | `cloudfront:ListDistributions` |
| `dynamodb` | regional | DynamoTable | `dynamodb:ListTables`, `dynamodb:DescribeTable`, `dynamodb:DescribeContinuousBackups` |
| `ec2` | regional | Ec2Instance, EbsVolume, ElasticIp | `ec2:DescribeInstances`, `ec2:DescribeVolumes`, `ec2:DescribeAddresses` |
| `ecs` | regional | EcsCluster, EcsService | `ecs:ListClusters`, `ecs:ListServices`, `ecs:DescribeServices`, `ecs:DescribeTaskDefinition` |
| `eks` | regional | EksCluster, EksNodeGroup | `eks:ListClusters`, `eks:DescribeCluster`, `eks:ListNodegroups`, `eks:DescribeNodegroup`, `eks:ListPodIdentityAssociations`, `eks:DescribePodIdentityAssociation` |
| `elbv2` | regional | LoadBalancer, TargetGroup | `elasticloadbalancing:DescribeLoadBalancers`, `elasticloadbalancing:DescribeListeners`, `elasticloadbalancing:DescribeTargetGroups`, `elasticloadbalancing:DescribeTargetHealth` |
| `iam` | global | IamRole, IamUser, IamGroup, IamPolicy, InstanceProfile | `iam:GetAccountAuthorizationDetails`, `iam:ListRoles`, `iam:ListUsers`, `iam:GetPolicy`, `iam:GetPolicyVersion` |
| `kms` | regional | KmsKey | `kms:ListKeys`, `kms:DescribeKey`, `kms:GetKeyPolicy`, `kms:GetKeyRotationStatus` |
| `lambda` | regional | LambdaFunction | `lambda:ListFunctions` |
| `rds` | regional | RdsInstance, DbSubnetGroup | `rds:DescribeDBInstances`, `rds:DescribeDBSubnetGroups` |
| `route53` | global | HostedZone | `route53:ListHostedZones`, `route53:ListResourceRecordSets` |
| `s3` | global | S3Bucket | `s3:ListAllMyBuckets`, `s3:GetBucketLocation`, `s3:GetBucketPolicy`, `s3:GetBucketPolicyStatus`, `s3:GetBucketPublicAccessBlock`, `s3:GetBucketAcl`, `s3:GetBucketTagging` |
| `secretsmanager` | regional | Secret | `secretsmanager:ListSecrets`, `secretsmanager:GetResourcePolicy` |
| `sns` | regional | SnsTopic | `sns:ListTopics`, `sns:GetTopicAttributes` |
| `sqs` | regional | SqsQueue | `sqs:ListQueues`, `sqs:GetQueueAttributes` |
| `vpc` | regional | Vpc, Subnet, SecurityGroup, InternetGateway, NatGateway, RouteTable, NetworkAcl, VpcPeeringConnection, TransitGateway, VpcEndpoint, VpcEndpointService | `ec2:DescribeVpcs`, `ec2:DescribeSubnets`, `ec2:DescribeSecurityGroups`, `ec2:DescribeInternetGateways`, `ec2:DescribeNatGateways`, `ec2:DescribeRouteTables`, `ec2:DescribeNetworkAcls`, `ec2:DescribeVpcPeeringConnections`, `ec2:DescribeTransitGateways`, `ec2:DescribeTransitGatewayAttachments`, `ec2:DescribeTransitGatewayRouteTables`, `ec2:SearchTransitGatewayRoutes`, `ec2:DescribeVpcEndpoints`, `ec2:DescribeVpcEndpointServiceConfigurations` |

64 actions across 18 services.

## Adding a service

1. Write the collector in this directory: `(ctx) => { resources, relationships }`.
2. Add its entry to `registry.ts`: scope, the kinds it emits, the actions it calls.
3. Add the service id to `SCANNABLE_SERVICES` in `packages/shared`.
4. Run `npm run gen:collectors -w @sightline/api` and commit what it changes.
