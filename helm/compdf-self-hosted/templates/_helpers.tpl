{{- define "compdf.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "compdf.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "compdf.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "compdf.labels" -}}
app.kubernetes.io/name: {{ include "compdf.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end }}

{{- define "compdf.selectorLabels" -}}
app.kubernetes.io/name: {{ include "compdf.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "compdf.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "compdf.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "compdf.image" -}}
{{- $image := index . 0 -}}
{{- if $image.digest -}}
{{ printf "%s@%s" $image.repository $image.digest }}
{{- else -}}
{{ printf "%s:%s" $image.repository $image.tag }}
{{- end -}}
{{- end }}

{{- define "compdf.databaseHost" -}}
{{- if .Values.infra.enabled -}}
{{ printf "%s-infra" (include "compdf.fullname" .) }}
{{- else -}}
{{ required "external.databaseHost is required when infra.enabled=false" .Values.external.databaseHost }}
{{- end -}}
{{- end }}

{{- define "compdf.redisHost" -}}
{{- if .Values.infra.enabled -}}
{{ printf "%s-infra" (include "compdf.fullname" .) }}
{{- else -}}
{{ required "external.redisHost is required when infra.enabled=false" .Values.external.redisHost }}
{{- end -}}
{{- end }}

{{- define "compdf.s3Endpoint" -}}
{{- if .Values.infra.enabled -}}
{{ printf "http://%s-infra:%v" (include "compdf.fullname" .) .Values.infra.s3Port }}
{{- else -}}
{{ required "external.s3Endpoint is required when infra.enabled=false" .Values.external.s3Endpoint }}
{{- end -}}
{{- end }}
