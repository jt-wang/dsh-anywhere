const EN = {
  title: 'Computer settings', open: 'Read computer settings', refresh: 'Refresh from computer', close: 'Close',
  hint: 'These are the computer’s live settings, not phone preferences. Save updates the computer and reads it back. Keys never appear in a read.',
  save: 'Save', reset: 'Use inherited value', add: 'Add entry', key: 'New entry name', value: 'Value',
  configured: 'Configured · enter to replace', notConfigured: 'Not configured', readOnly: 'The computer has no writable settings document.',
  failed: 'Could not read computer settings. Reconnect and refresh.', rejected: 'Not saved. Check the value and refresh if it changed on the computer.',
  uncertain: 'The computer has not confirmed this value. Refresh before trying again.', saved: 'Saved and confirmed by the computer.',
  conflict: 'This setting changed on the computer. Refresh, review the new value, then edit again.', loading: 'Reading computer settings…',
  credentials: 'Provider keys', reference: 'Credential reference', setKey: 'Save key', removeKey: 'Remove key',
  credentialHint: 'Use the provider’s apiKeyEnv reference. Keys are stored on the computer only.',
  prepare: 'Prepare local speech model', preparing: 'Preparing on the computer…', prepared: 'Speech model ready.',
  speechHint: 'Free speech recognition runs on your computer. The default INT8 model downloads about 241 MB once. Recording only fills your draft.',
}
type Words = typeof EN
const translations: Record<string, string[]> = {
  zh: ['电脑设置', '读取电脑设置', '从电脑刷新', '关闭', '这里是电脑实时设置，不是手机偏好。保存后会更新电脑并权威回读。密钥不会出现在回读中。', '保存', '使用继承值', '新增条目', '新条目名称', '值', '已配置，输入以替换', '未配置', '电脑上没有可写的设置文档。', '无法读取电脑设置，请重连后刷新。', '未保存，请检查值；如果电脑设置已改变，请刷新。', '电脑尚未确认此值，请先刷新再试。', '已保存，电脑已确认。', '此设置在电脑上已改变。请刷新并查看新值后再编辑。', '正在读取电脑设置…', '提供商密钥', '凭据引用', '保存密钥', '移除密钥', '使用提供商的 apiKeyEnv 引用。密钥仅保存在电脑。', '准备本地语音模型', '正在电脑上准备…', '语音模型已就绪。', '免费语音识别在电脑上运行。默认 INT8 模型首次下载约241 MB。录音只会回填草稿。'],
  'zh-Hant': ['電腦設定', '讀取電腦設定', '從電腦重新整理', '關閉', '這裡是電腦即時設定，不是手機偏好。儲存後會更新電腦並權威回讀。金鑰不會出現在回讀中。', '儲存', '使用繼承值', '新增項目', '新項目名稱', '值', '已設定，輸入以取代', '未設定', '電腦上沒有可寫的設定文件。', '無法讀取電腦設定，請重新連線後重新整理。', '未儲存，請檢查值；如果電腦設定已變更，請重新整理。', '電腦尚未確認此值，請先重新整理再試。', '已儲存，電腦已確認。', '此設定在電腦上已變更。請重新整理並檢視新值後再編輯。', '正在讀取電腦設定…', '供應商金鑰', '憑據引用', '儲存金鑰', '移除金鑰', '使用供應商的 apiKeyEnv 引用。金鑰僅儲存在電腦。', '準備本機語音模型', '正在電腦上準備…', '語音模型已就緒。', '免費語音辨識在電腦上執行。預設 INT8 模型首次下載約241 MB。錄音僅會回填草稿。'],
  es: ['Ajustes del ordenador', 'Leer ajustes del ordenador', 'Actualizar desde el ordenador', 'Cerrar', 'Ajustes en vivo del ordenador, no del teléfono. Guardar vuelve a leer el valor confirmado. Las claves nunca se muestran.', 'Guardar', 'Usar valor heredado', 'Añadir entrada', 'Nombre de entrada', 'Valor', 'Configurado · escribe para sustituir', 'Sin configurar', 'El ordenador no tiene un documento de ajustes editable.', 'No se pudieron leer los ajustes. Reconecta y actualiza.', 'No guardado. Revisa el valor y actualiza si cambió en el ordenador.', 'El ordenador no ha confirmado el valor. Actualiza antes de reintentar.', 'Guardado y confirmado por el ordenador.', 'Este ajuste cambió en el ordenador. Actualiza y revisa el valor antes de editar.', 'Leyendo ajustes…', 'Claves de proveedores', 'Referencia de credencial', 'Guardar clave', 'Eliminar clave', 'Usa la referencia apiKeyEnv del proveedor. Las claves se guardan solo en el ordenador.', 'Preparar modelo de voz local', 'Preparando en el ordenador…', 'Modelo de voz listo.', 'Reconocimiento gratuito en tu ordenador. El modelo INT8 descarga unos 241 MB una vez. Solo rellena el borrador.'],
  fr: ['Réglages de l’ordinateur', 'Lire les réglages', 'Actualiser depuis l’ordinateur', 'Fermer', 'Réglages actifs de l’ordinateur, pas du téléphone. Enregistrer relit la valeur confirmée. Les clés ne sont jamais affichées.', 'Enregistrer', 'Utiliser la valeur héritée', 'Ajouter une entrée', 'Nom de l’entrée', 'Valeur', 'Configuré · saisir pour remplacer', 'Non configuré', 'L’ordinateur n’a pas de document de réglages modifiable.', 'Lecture impossible. Reconnectez-vous et actualisez.', 'Non enregistré. Vérifiez la valeur et actualisez si elle a changé.', 'Valeur non confirmée par l’ordinateur. Actualisez avant de réessayer.', 'Enregistré et confirmé par l’ordinateur.', 'Ce réglage a changé sur l’ordinateur. Actualisez et vérifiez avant de modifier.', 'Lecture des réglages…', 'Clés des fournisseurs', 'Référence d’identifiant', 'Enregistrer la clé', 'Supprimer la clé', 'Utilisez la référence apiKeyEnv du fournisseur. Les clés restent sur l’ordinateur.', 'Préparer le modèle vocal local', 'Préparation sur l’ordinateur…', 'Modèle vocal prêt.', 'Reconnaissance gratuite sur votre ordinateur. Le modèle INT8 télécharge environ 241 Mo une fois. Seul le brouillon est rempli.'],
  ko: ['컴퓨터 설정', '컴퓨터 설정 읽기', '컴퓨터에서 새로고침', '닫기', '휴대폰 환경설정이 아닌 컴퓨터의 실시간 설정입니다. 저장 후 컴퓨터에서 확인합니다. 키는 표시되지 않습니다.', '저장', '상속된 값 사용', '항목 추가', '새 항목 이름', '값', '설정됨 · 변경하려면 입력', '미설정', '컴퓨터에 쓸 수 있는 설정 문서가 없습니다.', '설정을 읽을 수 없습니다. 다시 연결하고 새로고침하세요.', '저장되지 않았습니다. 값을 확인하고 컴퓨터에서 바뀌었으면 새로고침하세요.', '컴퓨터에서 값을 확인하지 못했습니다. 다시 시도하기 전에 새로고침하세요.', '컴퓨터에서 저장을 확인했습니다.', '컴퓨터에서 이 설정이 변경되었습니다. 새로고침하고 값을 검토한 후 편집하세요.', '설정 읽는 중…', '제공업체 키', '자격 증명 참조', '키 저장', '키 삭제', '제공업체의 apiKeyEnv 참조를 사용하세요. 키는 컴퓨터에만 저장됩니다.', '로컬 음성 모델 준비', '컴퓨터에서 준비 중…', '음성 모델 준비 완료.', '컴퓨터에서 무료로 음성을 인식합니다. 기본 INT8 모델은 최초에 약 241 MB를 다운로드합니다. 초안에만 입력됩니다.'],
  ja: ['コンピュータの設定', '設定を読み込む', 'コンピュータから更新', '閉じる', '携帯の設定ではなくコンピュータの現在の設定です。保存後に確認のため再読込します。キーは表示されません。', '保存', '継承した値を使用', '項目を追加', '新しい項目名', '値', '設定済み・入力で置換', '未設定', '書き込み可能な設定ファイルがありません。', '設定を読み込めません。再接続して更新してください。', '未保存です。値を確認し、コンピュータで変更された場合は更新してください。', '値を確認できませんでした。再試行の前に更新してください。', '保存されコンピュータで確認済みです。', 'コンピュータで設定が変更されました。更新して新しい値を確認してから編集してください。', '設定を読み込み中…', 'プロバイダーのキー', '認証情報の参照', 'キーを保存', 'キーを削除', 'プロバイダーの apiKeyEnv 参照を使います。キーはコンピュータのみに保存されます。', 'ローカル音声モデルを準備', 'コンピュータで準備中…', '音声モデルの準備完了。', '無料の音声認識をコンピュータで実行します。既定の INT8 モデルは初回に約241 MBをダウンロードします。下書きのみに入力します。'],
  ru: ['Настройки компьютера', 'Прочитать настройки', 'Обновить с компьютера', 'Закрыть', 'Текущие настройки компьютера, не телефона. После сохранения значение проверяется чтением. Ключи не отображаются.', 'Сохранить', 'Использовать унаследованное', 'Добавить запись', 'Имя новой записи', 'Значение', 'Настроено · введите для замены', 'Не настроено', 'На компьютере нет доступного для записи документа настроек.', 'Не удалось прочитать настройки. Подключитесь и обновите.', 'Не сохранено. Проверьте значение и обновите, если оно изменилось на компьютере.', 'Компьютер не подтвердил значение. Обновите перед повтором.', 'Сохранение подтверждено компьютером.', 'Настройка изменилась на компьютере. Обновите и проверьте значение перед правкой.', 'Чтение настроек…', 'Ключи провайдеров', 'Ссылка на учётные данные', 'Сохранить ключ', 'Удалить ключ', 'Используйте ссылку apiKeyEnv провайдера. Ключи хранятся только на компьютере.', 'Подготовить локальную модель речи', 'Подготовка на компьютере…', 'Речевая модель готова.', 'Бесплатное распознавание на компьютере. Модель INT8 однократно загружает около 241 МБ. Результат попадает только в черновик.'],
}
export function desktopSettingsStrings(locale: string): Words {
  const l = locale.replace(/_/g, '-').toLowerCase()
  const key = l.startsWith('zh') ? /hant|tw|hk|mo/.test(l) ? 'zh-Hant' : 'zh' : l.split('-')[0]
  const values = translations[key]
  return values ? Object.fromEntries(Object.keys(EN).map((k, i) => [k, values[i]])) as Words : EN
}

export function desktopSettingsScope(locale: string) {
  const l = locale.replace(/_/g, '-').toLowerCase()
  const key = l.startsWith('zh') ? /hant|tw|hk|mo/.test(l) ? 'zh-Hant' : 'zh' : l.split('-')[0]
  const copy: Record<string, string[]> = {
    en: ['Keyboard shortcuts and update channel: can only be set on the computer.', 'Advanced live settings'],
    zh: ['快捷键、更新渠道：只能在电脑上设置。', '高级实时设置'],
    'zh-Hant': ['快捷鍵、更新管道：只能在電腦上設定。', '進階即時設定'],
    es: ['Atajos de teclado y canal de actualización: solo se configuran en el ordenador.', 'Ajustes avanzados en vivo'],
    fr: ['Raccourcis clavier et canal de mise à jour : réglables uniquement sur l’ordinateur.', 'Réglages avancés en direct'],
    ko: ['키보드 단축키와 업데이트 채널은 컴퓨터에서만 설정할 수 있습니다.', '고급 실시간 설정'],
    ja: ['キーボードショートカットと更新チャネルはコンピュータでのみ設定できます。', '高度なライブ設定'],
    ru: ['Сочетания клавиш и канал обновлений настраиваются только на компьютере.', 'Расширенные текущие настройки'],
  }
  return copy[key] ?? copy.en
}
