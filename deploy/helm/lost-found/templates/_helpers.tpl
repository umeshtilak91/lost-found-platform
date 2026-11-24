{{- define "lf.labels" -}}
app.kubernetes.io/part-of: lost-found
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "lf.apiImage" -}}
{{- required "api.image.tag is required (immutable git SHA)" .Values.api.image.tag | printf "%s/%s:%s" .Values.image.registry .Values.api.image.repository -}}
{{- end -}}

{{- define "lf.webImage" -}}
{{- required "web.image.tag is required (immutable git SHA)" .Values.web.image.tag | printf "%s/%s:%s" .Values.image.registry .Values.web.image.repository -}}
{{- end -}}

{{- define "lf.podSecurity" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
  seccompProfile:
    type: RuntimeDefault
{{- end -}}

{{- define "lf.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
{{- end -}}

{{- define "lf.apiEnv" -}}
- name: NODE_ENV
  value: production
- name: PORT
  value: "5000"
- name: APP_URL
  value: {{ .Values.appUrl | quote }}
{{- range $key, $value := .Values.api.env }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
{{- end -}}
