# Terms of use

Short, because it is a personal project and a long document would be pretending
otherwise. Nothing here is a substitute for legal advice, including to me.

## What this is

Sightline reads the configuration of an AWS account you connect to it and shows
you what is in it. It is run by one person, on one machine, as a personal
project. There is no company, no contract, no support commitment and no SLA.

Using it means you accept that, and the rest of this page.

## What you are agreeing to do

**Connect only accounts you are entitled to connect.** Deploying the
CloudFormation stack grants Sightline read access to an AWS account. If it is
not yours, you need the permission of whoever owns it — and "I had the console
open" is not that permission.

**Not use it against anyone else's infrastructure.** Sightline reads the account
whose role trusts it. Trying to make it read anything else, or using what it
tells you to attack an estate you are not responsible for, ends your access and
is not something I will help with.

**Not treat it as a security control.** It is an inventory and a set of
heuristics. The policy analyser is not an IAM evaluator: it does not model
permission boundaries, service control policies or session policies, so
"effectively an administrator" is a strong hint and not a proof. The
reachability analysis reads security groups and route tables, not your actual
network. A finding is a thing to go and check.

**Not rely on its availability.** One node, one replica of each datastore, a
home internet connection, and a backup whose restore is tested but which still
means downtime. It can be unavailable at any time, and it can lose a day of scan
history in the worst case.

## What I am agreeing to do

**Not read your data.** The role you deploy carries an explicit Deny on
data-plane reads, so this is a property of the role rather than a promise about
my behaviour — but it is also a promise about my behaviour.

**Not sell or share your inventory.** See [`PRIVACY.md`](PRIVACY.md) for the
three mechanical exceptions: AWS, your identity provider, and Anthropic when you
use the assistant.

**Delete it when you ask.** `DELETE /api/me`, immediately, including the
encrypted ExternalIds. The caveats — your CloudFormation stack, and encrypted
backups for up to 30 days — are in [`PRIVACY.md`](PRIVACY.md#deleting-it).

**Tell you when something goes wrong** rather than reporting success and hoping.
A partially failed scan says which service and which region failed and why; it
does not quietly return half an inventory as though it were whole.

## Limits

There are per-account limits on how often you can scan and how many questions
you can ask the assistant per hour. They exist because a scan spends AWS API
calls and an answer spends tokens on somebody's bill, and that somebody is me.
They are not negotiable, and they are visible in the refusal when you hit one.

I may also turn scanning or the assistant off entirely while looking at a
problem. The application says so rather than failing confusingly.

## No warranty, and no liability

The software and the service are provided **as is**, without warranty of any
kind. I am not liable for anything arising from your use of them — including
decisions made on the basis of a finding that turned out to be wrong, downtime,
or data loss.

If that is not an acceptable trade for your production estate, self-host it. The
code is [MIT-licensed](LICENSE) and the deployment instructions are in
[`deploy/k8s/README.md`](deploy/k8s/README.md); a clone reads your account with
your own credentials and your own API key, and none of your data goes anywhere
near my machine.

## Ending it

You can stop at any time: delete your account, then delete the CloudFormation
stack. I may withdraw access from an account that is abusing the service or
scanning infrastructure it has no business scanning, and I may shut the hosted
service down. If I do, the code and the deployment path remain.

## Changes

If these terms change materially, the change will be in the repository's git
history like everything else — which is a better record than "we may update this
page from time to time".
