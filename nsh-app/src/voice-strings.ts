// Voice-only words, independent of the shared settings dictionary. Unsupported languages read English.
const EN = {
  start: 'Record voice', stop: 'Stop and transcribe', cancel: 'Cancel voice input', checking: 'Checking speech recognition…',
  recording: 'Recording · up to 60 seconds. Stop to transcribe into your draft.', transcribing: 'Transcribing… Cancel discards the result; the computer may finish processing.',
  permission: 'Microphone access was denied. Enable it in system settings to record.', unavailable: 'Speech recognition is unavailable. Check speech settings on your computer.',
  notReady: 'Prepare the selected speech model in settings first.', failed: 'Voice input failed. Nothing was sent to the chat. Try recording again.', empty: 'No speech was recognized. Your draft is unchanged.',
}
type Words = typeof EN
const translations: Record<string, string[]> = {
  'zh': ['录音输入', '停止并转写', '取消语音输入', '正在检查语音识别…', '正在录音，最长60秒。停止后转写到草稿。', '正在转写…取消将丢弃结果，电脑可能仍会完成处理。', '麦克风权限被拒绝。请在系统设置中允许录音。', '语音识别不可用，请检查电脑上的语音设置。', '请先在设置中准备所选语音模型。', '语音输入失败，未发送聊天消息。请重新录音。', '未识别到语音，草稿未变。'],
  'zh-Hant': ['錄音輸入', '停止並轉寫', '取消語音輸入', '正在檢查語音辨識…', '正在錄音，最長60秒。停止後轉寫到草稿。', '正在轉寫…取消將捨棄結果，電腦可能仍會完成處理。', '麥克風權限遭拒。請在系統設定中允許錄音。', '語音辨識無法使用，請檢查電腦上的語音設定。', '請先在設定中準備所選語音模型。', '語音輸入失敗，未傳送聊天訊息。請重新錄音。', '未辨識到語音，草稿未變。'],
  es: ['Grabar voz', 'Detener y transcribir', 'Cancelar entrada de voz', 'Comprobando reconocimiento…', 'Grabando · hasta 60 segundos. Detén para transcribir al borrador.', 'Transcribiendo… Cancelar descarta el resultado; el ordenador puede terminar de procesarlo.', 'Acceso al micrófono denegado. Actívalo en los ajustes del sistema.', 'Reconocimiento no disponible. Revisa los ajustes de voz del ordenador.', 'Prepara primero el modelo de voz seleccionado en ajustes.', 'Falló la entrada de voz. No se envió nada al chat. Vuelve a grabar.', 'No se reconoció voz. El borrador no cambió.'],
  fr: ['Enregistrer la voix', 'Arrêter et transcrire', 'Annuler la saisie vocale', 'Vérification de la reconnaissance…', 'Enregistrement · 60 secondes maximum. Arrêtez pour transcrire dans le brouillon.', 'Transcription… Annuler ignore le résultat ; l’ordinateur peut terminer le traitement.', 'Accès au microphone refusé. Autorisez-le dans les réglages système.', 'Reconnaissance indisponible. Vérifiez les réglages vocaux de l’ordinateur.', 'Préparez d’abord le modèle vocal sélectionné dans les réglages.', 'Échec de la saisie vocale. Rien n’a été envoyé au chat. Réessayez.', 'Aucune parole reconnue. Le brouillon est inchangé.'],
  ko: ['음성 녹음', '중지하고 텍스트로 변환', '음성 입력 취소', '음성 인식 확인 중…', '녹음 중 · 최대 60초. 중지하면 초안에 텍스트가 입력됩니다.', '변환 중… 취소하면 결과를 버립니다. 컴퓨터의 처리는 완료될 수 있습니다.', '마이크 권한이 거부되었습니다. 시스템 설정에서 허용하세요.', '음성 인식을 사용할 수 없습니다. 컴퓨터의 음성 설정을 확인하세요.', '먼저 설정에서 선택한 음성 모델을 준비하세요.', '음성 입력에 실패했습니다. 채팅에 전송되지 않았습니다. 다시 녹음하세요.', '인식된 음성이 없습니다. 초안은 변경되지 않았습니다.'],
  ja: ['音声を録音', '停止して文字起こし', '音声入力をキャンセル', '音声認識を確認中…', '録音中・最大60秒。停止すると下書きに文字を入力します。', '文字起こし中…キャンセルすると結果を破棄します。コンピュータの処理は完了する場合があります。', 'マイクの使用が拒否されました。システム設定で許可してください。', '音声認識を利用できません。コンピュータの音声設定を確認してください。', '先に設定で選択した音声モデルを準備してください。', '音声入力に失敗しました。チャットには送信されていません。もう一度録音してください。', '音声を認識できませんでした。下書きは変更されていません。'],
  ru: ['Записать голос', 'Остановить и распознать', 'Отменить голосовой ввод', 'Проверка распознавания…', 'Запись · до 60 секунд. Остановите для вставки текста в черновик.', 'Распознавание… Отмена отбросит результат; компьютер может завершить обработку.', 'Доступ к микрофону запрещён. Разрешите его в настройках системы.', 'Распознавание недоступно. Проверьте настройки речи на компьютере.', 'Сначала подготовьте выбранную речевую модель в настройках.', 'Ошибка голосового ввода. В чат ничего не отправлено. Запишите ещё раз.', 'Речь не распознана. Черновик не изменён.'],
}
export function voiceStrings(locale: string): Words {
  const l = locale.replace(/_/g, '-').toLowerCase()
  const key = l.startsWith('zh') ? /hant|tw|hk|mo/.test(l) ? 'zh-Hant' : 'zh' : l.split('-')[0]
  const values = translations[key]
  return values ? Object.fromEntries(Object.keys(EN).map((k, i) => [k, values[i]])) as Words : EN
}

const POLICY: Record<string, string> = {
  en: 'Free local recognition on your computer. Cloud is disabled: configured desktop keys cannot be verified.',
  zh: '使用电脑上的免费本地识别。无法核验电脑端是否已配置自有密钥，云端识别已禁用。',
  'zh-Hant': '使用電腦上的免費本機辨識。無法核驗電腦端是否已設定自有金鑰，雲端辨識已停用。',
  es: 'Reconocimiento local gratuito en tu ordenador. Nube desactivada: no se pueden verificar las claves del ordenador.',
  fr: 'Reconnaissance locale gratuite sur votre ordinateur. Cloud désactivé : les clés configurées ne peuvent pas être vérifiées.',
  ko: '컴퓨터에서 무료 로컬 인식을 사용합니다. 컴퓨터의 키 설정을 확인할 수 없어 클라우드는 비활성화됩니다.',
  ja: 'コンピュータ上で無料のローカル認識を使用します。設定済みキーを検証できないため、クラウドは無効です。',
  ru: 'Бесплатное локальное распознавание на компьютере. Облако отключено: нельзя проверить настроенные на компьютере ключи.',
}
export function voicePolicy(locale: string): string {
  const l = locale.replace(/_/g, '-').toLowerCase()
  return POLICY[l.startsWith('zh') ? /hant|tw|hk|mo/.test(l) ? 'zh-Hant' : 'zh' : l.split('-')[0]] ?? POLICY.en
}
