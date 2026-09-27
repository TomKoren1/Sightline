{{- define "daveio.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "daveio.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "daveio.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "daveio.labels" -}}
app.kubernetes.io/name: {{ include "daveio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
The API's environment, shared by the API deployment and the scan worker.

Both run the same image and need the same connection details; defining it once
means a variable added for one cannot be forgotten for the other - which would
present as "scans work in the API and fail in the worker", a confusing shape of
bug to chase.
*/}}
{{- define "daveio.apiEnv" -}}
- name: DEPLOYMENT_MODE
  value: {{ .Values.config.deploymentMode | quote }}
- name: PUBLIC_BASE_URL
  value: {{ .Values.config.publicBaseUrl | quote }}
- name: AWS_REGION
  value: {{ .Values.config.awsRegion | quote }}
- name: AWS_SCAN_REGIONS
  value: {{ .Values.config.scanRegions | quote }}
- name: LOG_LEVEL
  value: {{ .Values.config.logLevel | quote }}
- name: DATABASE_URL
  value: "postgres://{{ .Values.postgres.user }}:$(POSTGRES_PASSWORD)@{{ include "daveio.fullname" . }}-postgres:5432/{{ .Values.postgres.database }}"
- name: NEO4J_URI
  value: "bolt://{{ include "daveio.fullname" . }}-neo4j:7687"
- name: NEO4J_USER
  value: "neo4j"
{{- if .Values.demo.enabled }}
{{/*
  DEMO_AWS_ENDPOINT_URL, never AWS_ENDPOINT_URL: the second is an SDK-wide
  override that would redirect every signed call this process makes, and
  hosted mode refuses to start when it is set (ADR-015, ADR-020).
*/}}
- name: DEMO_AWS_ENDPOINT_URL
  value: "http://{{ include "daveio.fullname" . }}-moto:5000"
- name: DEMO_AWS_ACCOUNT_ID
  value: {{ .Values.demo.accountId | quote }}
{{- end }}
{{/*
  Secrets, from the SealedSecret. Never values.yaml, and never a ConfigMap:
  both are readable by anyone with get access to the namespace.
*/}}
- name: POSTGRES_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ include "daveio.fullname" . }}-secrets, key: POSTGRES_PASSWORD } }
- name: NEO4J_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ include "daveio.fullname" . }}-secrets, key: NEO4J_PASSWORD } }
- name: SESSION_SECRET
  valueFrom: { secretKeyRef: { name: {{ include "daveio.fullname" . }}-secrets, key: SESSION_SECRET } }
- name: GOOGLE_CLIENT_ID
  valueFrom: { secretKeyRef: { name: {{ include "daveio.fullname" . }}-secrets, key: GOOGLE_CLIENT_ID } }
- name: GOOGLE_CLIENT_SECRET
  valueFrom: { secretKeyRef: { name: {{ include "daveio.fullname" . }}-secrets, key: GOOGLE_CLIENT_SECRET } }
- name: AWS_KMS_KEY_ID
  valueFrom: { secretKeyRef: { name: {{ include "daveio.fullname" . }}-secrets, key: AWS_KMS_KEY_ID } }
{{/*
  The platform identity: the IAM user whose only permissions are AssumeRole on
  the scanner role name and KMS on the one key. Not a per-tenant credential -
  those live encrypted in Postgres.
*/}}
- name: AWS_ACCESS_KEY_ID
  valueFrom: { secretKeyRef: { name: {{ include "daveio.fullname" . }}-secrets, key: AWS_ACCESS_KEY_ID } }
- name: AWS_SECRET_ACCESS_KEY
  valueFrom: { secretKeyRef: { name: {{ include "daveio.fullname" . }}-secrets, key: AWS_SECRET_ACCESS_KEY } }
{{- end -}}
