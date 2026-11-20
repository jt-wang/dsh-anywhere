const en = {
  signOut: 'Sign out on computer', signOutWarning: 'Remove this computer’s account sign-in? API keys are kept. Account tasks may be interrupted, including tasks started after this check. Confirm only for the account shown.', runningTasks: 'Account tasks are currently running.',
  clientSync: 'Desktop browser module sync is local to that desktop client; it is not exposed by the host inventory RPC.',
  title: 'Computer services', refresh: 'Read / refresh', loading: 'Reading computer…', failed: 'Could not read. Check the connection and refresh.', unavailable: 'This computer does not expose this service.', empty: 'No entries.',
  presets: 'Agent presets', composition: 'Read composition', makeDefault: 'Set default for new chats', current: 'Default',
  cua: 'Computer use access', computer: 'These actions affect your computer, not this phone. Approve OS prompts on the computer. Retry approval clears a refusal; it does not grant access or replay work.',
  allowed: 'Allowed applications', blocked: 'Blocked applications', revoke: 'Revoke', retry: 'Allow asking again', request: 'Request on computer', settings: 'Open computer privacy settings',
  persistent: 'Persistent PTC configuration', enable: 'Enable persistent PTC', yes: 'Yes', no: 'No', unknown: 'Unknown',
  confirm: 'Confirm computer action', cancel: 'Cancel', uncertain: 'The action may have reached the computer. Refresh and inspect before trying again.', conflict: 'Settings changed elsewhere. Refresh before choosing again.',
  account: 'DSH account', callback: 'Sign in on the official computer app. This phone has no supported owner callback origin; it does not start a login or receive account tokens.',
  identity: 'Client build identity unavailable; account detail requests were not sent.', signedOut: 'Signed out', stored: 'Credential stored (not proof of validity)', profile: 'Profile', balance: 'Balance', bonus: 'Bonus balance', notices: 'Account notices', content: 'Read notice',
  plugins: 'Built-in plugins · read only', accessibility: 'Accessibility', screenRecording: 'Screen recording', sessionLocked: 'Desktop locked', captureAvailable: 'Capture available', elevated: 'Elevated',
}
type Words = { [K in keyof typeof en]: string }
const zh: Words = {
  signOut: '退出电脑账号', signOutWarning: '移除此电脑的账号登录？API 密钥会保留。账号任务可能中断，包括检查后新启动的任务。请核对当前账号后确认。', runningTasks: '当前有账号任务正在运行。',
  clientSync: '桌面浏览器模块同步属于该桌面客户端本地状态，宿主插件清单接口不提供此状态。',
  title: '电脑服务', refresh: '读取 / 刷新', loading: '正在读取电脑…', failed: '读取失败，请检查连接并刷新。', unavailable: '此电脑未提供该服务。', empty: '暂无条目。',
  presets: '智能体预设', composition: '查看组合', makeDefault: '设为新聊天默认', current: '默认', cua: '电脑使用授权', computer: '这些操作影响电脑而非手机。请在电脑确认系统弹窗。重新审批仅清除拒绝记录，不授予权限，也不重放任务。',
  allowed: '已允许的应用', blocked: '被阻止的应用', revoke: '撤销', retry: '允许再次询问', request: '在电脑请求权限', settings: '打开电脑隐私设置', persistent: '持久 PTC 配置', enable: '启用持久 PTC', yes: '是', no: '否', unknown: '未知',
  confirm: '确认电脑操作', cancel: '取消', uncertain: '操作可能已送达电脑。再次尝试前请刷新并检查。', conflict: '设置已被其他客户端修改，请刷新后再选择。', account: 'DSH 账号', callback: '请在官方电脑应用登录。手机没有受支持的所有者回调来源，不会发起登录或接收账号令牌。',
  identity: '无法获取客户端版本身份，未发送账号详情请求。', signedOut: '未登录', stored: '已存凭据（不代表有效）', profile: '个人资料', balance: '余额', bonus: '赠送余额', notices: '账号公告', content: '读取公告', plugins: '内置插件 · 只读', accessibility: '辅助功能', screenRecording: '屏幕录制', sessionLocked: '桌面已锁定', captureAvailable: '可截屏', elevated: '已提权',
}
const hant: Words = {
  signOut: '登出電腦帳號', signOutWarning: '移除此電腦的帳號登入？API 金鑰會保留。帳號工作可能中斷，包括檢查後才啟動的工作。請核對目前帳號後確認。', runningTasks: '目前有帳號工作正在執行。',
  clientSync: '桌面瀏覽器模組同步屬於該桌面客戶端本機狀態，主機外掛清單介面不提供此狀態。',
  title: '電腦服務', refresh: '讀取 / 重新整理', loading: '正在讀取電腦…', failed: '讀取失敗，請檢查連線並重新整理。', unavailable: '此電腦未提供該服務。', empty: '暫無項目。',
  presets: '代理預設', composition: '檢視組合', makeDefault: '設為新聊天預設', current: '預設', cua: '電腦使用授權', computer: '這些操作影響電腦而非手機。請在電腦確認系統提示。重新審批僅清除拒絕記錄，不授予權限，也不重播工作。',
  allowed: '已允許的應用程式', blocked: '遭封鎖的應用程式', revoke: '撤銷', retry: '允許再次詢問', request: '在電腦請求權限', settings: '開啟電腦隱私設定', persistent: '持久 PTC 設定', enable: '啟用持久 PTC', yes: '是', no: '否', unknown: '未知',
  confirm: '確認電腦操作', cancel: '取消', uncertain: '操作可能已送達電腦。重試前請重新整理並檢查。', conflict: '設定已由其他客戶端修改，請重新整理後再選擇。', account: 'DSH 帳號', callback: '請在官方電腦應用程式登入。手機沒有支援的擁有者回呼來源，不會發起登入或接收帳號權杖。',
  identity: '無法取得客戶端版本身分，未傳送帳號詳細資料請求。', signedOut: '未登入', stored: '已存憑證（不代表有效）', profile: '個人資料', balance: '餘額', bonus: '贈送餘額', notices: '帳號公告', content: '讀取公告', plugins: '內建外掛 · 唯讀', accessibility: '輔助使用', screenRecording: '螢幕錄製', sessionLocked: '桌面已鎖定', captureAvailable: '可擷取畫面', elevated: '已提升權限',
}
const es: Words = {
  signOut: 'Cerrar sesión en el ordenador', signOutWarning: '¿Quitar la sesión de cuenta de este ordenador? Se conservan las claves API. Las tareas de cuenta pueden interrumpirse, incluso las iniciadas después de esta comprobación. Confirma solo para la cuenta mostrada.', runningTasks: 'Hay tareas de cuenta en curso.',
  clientSync: 'La sincronización de módulos del navegador es local al cliente de escritorio; el RPC del inventario no la expone.',
  title: 'Servicios del ordenador', refresh: 'Leer / actualizar', loading: 'Leyendo el ordenador…', failed: 'No se pudo leer. Comprueba la conexión y actualiza.', unavailable: 'Este ordenador no ofrece este servicio.', empty: 'Sin entradas.',
  presets: 'Preajustes del agente', composition: 'Leer composición', makeDefault: 'Predeterminado para chats nuevos', current: 'Predeterminado', cua: 'Acceso al ordenador', computer: 'Estas acciones afectan al ordenador, no al teléfono. Aprueba los avisos del SO en el ordenador. Volver a preguntar solo borra el rechazo; no autoriza ni repite tareas.',
  allowed: 'Aplicaciones permitidas', blocked: 'Aplicaciones bloqueadas', revoke: 'Revocar', retry: 'Permitir otra consulta', request: 'Solicitar en el ordenador', settings: 'Abrir privacidad del ordenador', persistent: 'Configuración PTC persistente', enable: 'Activar PTC persistente', yes: 'Sí', no: 'No', unknown: 'Desconocido',
  confirm: 'Confirmar acción en el ordenador', cancel: 'Cancelar', uncertain: 'La acción puede haber llegado. Actualiza e inspecciona antes de reintentar.', conflict: 'La configuración cambió en otro cliente. Actualiza antes de elegir.', account: 'Cuenta DSH', callback: 'Inicia sesión en la aplicación oficial del ordenador. Este teléfono no tiene un origen de retorno de propietario compatible; no inicia sesión ni recibe tokens.',
  identity: 'Falta la identidad de versión del cliente; no se solicitaron detalles de cuenta.', signedOut: 'Sin sesión', stored: 'Credencial guardada (validez sin verificar)', profile: 'Perfil', balance: 'Saldo', bonus: 'Saldo de bonificación', notices: 'Avisos de cuenta', content: 'Leer aviso', plugins: 'Plugins integrados · solo lectura', accessibility: 'Accesibilidad', screenRecording: 'Grabación de pantalla', sessionLocked: 'Escritorio bloqueado', captureAvailable: 'Captura disponible', elevated: 'Privilegios elevados',
}
const fr: Words = {
  signOut: 'Déconnecter le compte de l’ordinateur', signOutWarning: 'Retirer la connexion au compte sur cet ordinateur ? Les clés API sont conservées. Des tâches du compte peuvent être interrompues, même celles démarrées après cette vérification. Vérifiez le compte affiché avant de confirmer.', runningTasks: 'Des tâches du compte sont en cours.',
  clientSync: 'La synchronisation des modules du navigateur est locale au client de bureau ; le RPC d’inventaire ne l’expose pas.',
  title: 'Services de l’ordinateur', refresh: 'Lire / actualiser', loading: 'Lecture de l’ordinateur…', failed: 'Lecture impossible. Vérifiez la connexion et actualisez.', unavailable: 'Cet ordinateur ne propose pas ce service.', empty: 'Aucune entrée.',
  presets: 'Préréglages de l’agent', composition: 'Lire la composition', makeDefault: 'Par défaut pour les nouvelles discussions', current: 'Par défaut', cua: 'Accès à l’ordinateur', computer: 'Ces actions concernent l’ordinateur, pas le téléphone. Validez les demandes système sur l’ordinateur. Réautoriser la demande efface seulement le refus, sans accorder l’accès ni rejouer le travail.',
  allowed: 'Applications autorisées', blocked: 'Applications bloquées', revoke: 'Révoquer', retry: 'Permettre une nouvelle demande', request: 'Demander sur l’ordinateur', settings: 'Ouvrir la confidentialité de l’ordinateur', persistent: 'Configuration PTC persistante', enable: 'Activer PTC persistant', yes: 'Oui', no: 'Non', unknown: 'Inconnu',
  confirm: 'Confirmer l’action sur l’ordinateur', cancel: 'Annuler', uncertain: 'L’action a peut-être été reçue. Actualisez et vérifiez avant de réessayer.', conflict: 'Les réglages ont changé ailleurs. Actualisez avant de choisir.', account: 'Compte DSH', callback: 'Connectez-vous dans l’application officielle de l’ordinateur. Ce téléphone n’a pas d’origine de rappel propriétaire prise en charge ; il ne lance pas la connexion et ne reçoit aucun jeton.',
  identity: 'Identité de version du client indisponible ; aucun détail de compte demandé.', signedOut: 'Déconnecté', stored: 'Identifiant enregistré (validité non vérifiée)', profile: 'Profil', balance: 'Solde', bonus: 'Solde bonus', notices: 'Annonces du compte', content: 'Lire l’annonce', plugins: 'Plugins intégrés · lecture seule', accessibility: 'Accessibilité', screenRecording: 'Enregistrement de l’écran', sessionLocked: 'Bureau verrouillé', captureAvailable: 'Capture disponible', elevated: 'Droits élevés',
}
const ko: Words = {
  signOut: '컴퓨터 계정 로그아웃', signOutWarning: '이 컴퓨터의 계정 로그인을 제거할까요? API 키는 유지됩니다. 확인 후 시작된 작업을 포함해 계정 작업이 중단될 수 있습니다. 표시된 계정을 확인하고 진행하세요.', runningTasks: '계정 작업이 실행 중입니다.',
  clientSync: '데스크톱 브라우저 모듈 동기화는 해당 클라이언트의 로컬 상태이며 호스트 목록 RPC에서 제공하지 않습니다.',
  title: '컴퓨터 서비스', refresh: '읽기 / 새로 고침', loading: '컴퓨터 읽는 중…', failed: '읽지 못했습니다. 연결을 확인하고 새로 고치세요.', unavailable: '이 컴퓨터는 이 서비스를 제공하지 않습니다.', empty: '항목이 없습니다.',
  presets: '에이전트 프리셋', composition: '구성 읽기', makeDefault: '새 채팅의 기본값으로 설정', current: '기본값', cua: '컴퓨터 사용 권한', computer: '이 작업은 휴대폰이 아닌 컴퓨터에 적용됩니다. 컴퓨터에서 OS 요청을 승인하세요. 재요청 허용은 거절만 지우며 권한을 부여하거나 작업을 재실행하지 않습니다.',
  allowed: '허용된 앱', blocked: '차단된 앱', revoke: '철회', retry: '다시 묻기 허용', request: '컴퓨터에서 요청', settings: '컴퓨터 개인정보 설정 열기', persistent: '영구 PTC 구성', enable: '영구 PTC 활성화', yes: '예', no: '아니요', unknown: '알 수 없음',
  confirm: '컴퓨터 작업 확인', cancel: '취소', uncertain: '작업이 컴퓨터에 도달했을 수 있습니다. 다시 시도하기 전에 새로 고치고 확인하세요.', conflict: '다른 곳에서 설정이 변경되었습니다. 새로 고친 후 선택하세요.', account: 'DSH 계정', callback: '공식 컴퓨터 앱에서 로그인하세요. 이 휴대폰에는 지원되는 소유자 콜백 출처가 없어 로그인을 시작하거나 계정 토큰을 받지 않습니다.',
  identity: '클라이언트 빌드 정보를 사용할 수 없어 계정 세부 요청을 보내지 않았습니다.', signedOut: '로그아웃됨', stored: '자격 증명 저장됨 (유효성 미확인)', profile: '프로필', balance: '잔액', bonus: '보너스 잔액', notices: '계정 공지', content: '공지 읽기', plugins: '내장 플러그인 · 읽기 전용', accessibility: '손쉬운 사용', screenRecording: '화면 기록', sessionLocked: '데스크톱 잠김', captureAvailable: '캡처 가능', elevated: '관리자 권한',
}
const ja: Words = {
  signOut: 'コンピュータのアカウントをログアウト', signOutWarning: 'このコンピュータのアカウントログインを削除しますか？API キーは保持されます。確認後に開始されたものも含め、アカウントのタスクが中断される場合があります。表示中のアカウントを確認してください。', runningTasks: 'アカウントのタスクが実行中です。',
  clientSync: 'デスクトップのブラウザモジュール同期はそのクライアントのローカル状態であり、ホストの一覧 RPC では取得できません。',
  title: 'コンピュータのサービス', refresh: '読み取り / 更新', loading: 'コンピュータを読み取り中…', failed: '読み取れません。接続を確認して更新してください。', unavailable: 'このコンピュータはこのサービスを提供していません。', empty: '項目なし。',
  presets: 'エージェントプリセット', composition: '構成を読む', makeDefault: '新しいチャットの既定に設定', current: '既定', cua: 'コンピュータ操作の許可', computer: 'これらの操作は電話ではなくコンピュータに適用されます。OSの確認はコンピュータで行ってください。再確認の許可は拒否を消すだけで、アクセス許可や作業の再実行は行いません。',
  allowed: '許可されたアプリ', blocked: 'ブロックされたアプリ', revoke: '取り消す', retry: '再確認を許可', request: 'コンピュータで要求', settings: 'コンピュータのプライバシー設定を開く', persistent: '永続 PTC 構成', enable: '永続 PTC を有効化', yes: 'はい', no: 'いいえ', unknown: '不明',
  confirm: 'コンピュータ操作を確認', cancel: 'キャンセル', uncertain: '操作がコンピュータに届いた可能性があります。再試行前に更新して確認してください。', conflict: '別の場所で設定が変更されました。更新してから選択してください。', account: 'DSH アカウント', callback: '公式コンピュータアプリでログインしてください。この電話には対応する所有者コールバック元がないため、ログインを開始せず、トークンも受信しません。',
  identity: 'クライアントのビルド識別情報がないため、アカウント詳細を要求していません。', signedOut: '未ログイン', stored: '認証情報保存済み（有効性未確認）', profile: 'プロフィール', balance: '残高', bonus: 'ボーナス残高', notices: 'アカウントのお知らせ', content: 'お知らせを読む', plugins: '組み込みプラグイン · 読み取り専用', accessibility: 'アクセシビリティ', screenRecording: '画面収録', sessionLocked: 'デスクトップがロック中', captureAvailable: 'キャプチャ可能', elevated: '昇格済み',
}
const ru: Words = {
  signOut: 'Выйти из аккаунта на компьютере', signOutWarning: 'Удалить вход в аккаунт на этом компьютере? Ключи API сохранятся. Задачи аккаунта могут прерваться, в том числе начатые после этой проверки. Подтверждайте только для показанного аккаунта.', runningTasks: 'Сейчас выполняются задачи аккаунта.',
  clientSync: 'Синхронизация модулей браузера — локальное состояние клиента компьютера; RPC инвентаря его не предоставляет.',
  title: 'Службы компьютера', refresh: 'Прочитать / обновить', loading: 'Чтение с компьютера…', failed: 'Не удалось прочитать. Проверьте соединение и обновите.', unavailable: 'Компьютер не предоставляет эту службу.', empty: 'Нет записей.',
  presets: 'Пресеты агента', composition: 'Прочитать состав', makeDefault: 'По умолчанию для новых чатов', current: 'По умолчанию', cua: 'Доступ к компьютеру', computer: 'Эти действия касаются компьютера, а не телефона. Подтвердите запросы ОС на компьютере. Повторный запрос только снимает отказ, не выдаёт доступ и не повторяет работу.',
  allowed: 'Разрешённые приложения', blocked: 'Заблокированные приложения', revoke: 'Отозвать', retry: 'Разрешить новый запрос', request: 'Запросить на компьютере', settings: 'Открыть настройки приватности компьютера', persistent: 'Постоянная конфигурация PTC', enable: 'Включить постоянную PTC', yes: 'Да', no: 'Нет', unknown: 'Неизвестно',
  confirm: 'Подтвердить действие на компьютере', cancel: 'Отмена', uncertain: 'Действие могло дойти до компьютера. Обновите и проверьте перед повтором.', conflict: 'Настройки изменены другим клиентом. Обновите перед выбором.', account: 'Аккаунт DSH', callback: 'Войдите в официальном приложении компьютера. У телефона нет поддерживаемого адреса обратного вызова владельца; он не начинает вход и не получает токены.',
  identity: 'Версия клиента недоступна; запросы данных аккаунта не отправлены.', signedOut: 'Вход не выполнен', stored: 'Данные входа сохранены (валидность не проверена)', profile: 'Профиль', balance: 'Баланс', bonus: 'Бонусный баланс', notices: 'Уведомления аккаунта', content: 'Прочитать уведомление', plugins: 'Встроенные плагины · только чтение', accessibility: 'Универсальный доступ', screenRecording: 'Запись экрана', sessionLocked: 'Рабочий стол заблокирован', captureAvailable: 'Захват доступен', elevated: 'Повышенные права',
}
export function hostSettingsStrings(tag: string): Words {
  const t = tag.toLowerCase().replace(/_/g, '-')
  return t.startsWith('zh') ? /(?:hant|tw|hk|mo)/.test(t) ? hant : zh : ({ en, es, fr, ko, ja, ru } as Record<string, Words>)[t.split('-')[0]] ?? en
}
