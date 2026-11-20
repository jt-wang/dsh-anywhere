import { locale } from 'nsh'
import { language } from './strings.ts'

const en = {
  ready: 'Continue generation', receipt: 'Generation continuation requested', loading: 'Checking continuation…',
  unsupported: 'Continuation is not enabled for this DSH version. Use a verified DSH 0.2.2-rc.5 host.',
  unknown: 'Continuation capability could not be verified. No continuation was sent.',
  unavailable: 'DSH does not currently allow continuing this failure. Check the computer or send a new message.',
  sending: 'Requesting continuation…', queued: 'Continuation accepted. Waiting for the recorded turn.',
  unconfirmed: 'Continuation not confirmed. Check the chat before trying again; it may already have started.',
  retry: 'Check and retry the same request', refresh: 'Check again',
  draft: 'Clear the draft and attachments before continuing.', offline: 'Connect to the computer to continue.',
}
type Copy = typeof en
const copies: Record<string, Copy> = {
  en,
  zh: { ready: '继续生成', receipt: '已请求继续生成', loading: '正在检查能否继续…', unsupported: '此 DSH 版本未启用继续生成，请使用已验证的 DSH 0.2.2-rc.5。', unknown: '无法确认继续生成能力，未发送继续请求。', unavailable: 'DSH 当前不允许继续此次失败，请检查电脑或发送新消息。', sending: '正在请求继续…', queued: '继续请求已受理，等待会话记录。', unconfirmed: '继续请求未确认，可能已经开始。重试前请先检查会话。', retry: '检查并重试同一请求', refresh: '重新检查', draft: '请先清空草稿和附件，再继续生成。', offline: '连接电脑后才能继续生成。' },
  'zh-Hant': { ready: '繼續生成', receipt: '已請求繼續生成', loading: '正在檢查能否繼續…', unsupported: '此 DSH 版本未啟用繼續生成，請使用已驗證的 DSH 0.2.2-rc.5。', unknown: '無法確認繼續生成能力，未傳送繼續請求。', unavailable: 'DSH 目前不允許繼續此次失敗，請檢查電腦或傳送新訊息。', sending: '正在請求繼續…', queued: '繼續請求已受理，等待對話記錄。', unconfirmed: '繼續請求未確認，可能已經開始。重試前請先檢查對話。', retry: '檢查並重試同一請求', refresh: '重新檢查', draft: '請先清空草稿和附件，再繼續生成。', offline: '連接電腦後才能繼續生成。' },
  es: { ready: 'Continuar generación', receipt: 'Se solicitó continuar la generación', loading: 'Comprobando continuación…', unsupported: 'Continuación no habilitada para esta versión de DSH. Usa DSH 0.2.2-rc.5 verificado.', unknown: 'No se pudo verificar la capacidad de continuación. No se envió ninguna solicitud.', unavailable: 'DSH no permite continuar este fallo ahora. Revisa el ordenador o envía un mensaje nuevo.', sending: 'Solicitando continuación…', queued: 'Continuación aceptada. Esperando el turno registrado.', unconfirmed: 'Continuación sin confirmar. Revisa el chat antes de reintentar; puede haber comenzado.', retry: 'Comprobar y reintentar la misma solicitud', refresh: 'Comprobar de nuevo', draft: 'Borra el borrador y los adjuntos antes de continuar.', offline: 'Conecta con el ordenador para continuar.' },
  fr: { ready: 'Continuer la génération', receipt: 'Continuation de la génération demandée', loading: 'Vérification de la continuation…', unsupported: 'Continuation non activée pour cette version de DSH. Utilisez DSH 0.2.2-rc.5 vérifié.', unknown: 'Impossible de vérifier la capacité de continuation. Aucune demande envoyée.', unavailable: 'DSH ne permet pas de continuer cet échec actuellement. Vérifiez l’ordinateur ou envoyez un nouveau message.', sending: 'Demande de continuation…', queued: 'Continuation acceptée. En attente du tour enregistré.', unconfirmed: 'Continuation non confirmée. Vérifiez le chat avant de réessayer ; elle a peut-être déjà commencé.', retry: 'Vérifier et réessayer la même demande', refresh: 'Vérifier à nouveau', draft: 'Effacez le brouillon et les pièces jointes avant de continuer.', offline: 'Connectez-vous à l’ordinateur pour continuer.' },
  ko: { ready: '생성 계속', receipt: '생성 계속 요청됨', loading: '계속 가능 여부 확인 중…', unsupported: '이 DSH 버전에서는 계속 기능을 사용하지 않습니다. 검증된 DSH 0.2.2-rc.5를 사용하세요.', unknown: '계속 기능을 확인할 수 없습니다. 요청을 보내지 않았습니다.', unavailable: '현재 DSH에서 이 실패를 계속할 수 없습니다. 컴퓨터를 확인하거나 새 메시지를 보내세요.', sending: '계속 요청 중…', queued: '계속 요청이 수락되었습니다. 대화 기록을 기다리는 중입니다.', unconfirmed: '계속 요청이 확인되지 않았습니다. 이미 시작되었을 수 있으니 재시도 전에 대화를 확인하세요.', retry: '확인 후 같은 요청 재시도', refresh: '다시 확인', draft: '계속하려면 초안과 첨부 파일을 먼저 지우세요.', offline: '계속하려면 컴퓨터에 연결하세요.' },
  ja: { ready: '生成を続ける', receipt: '生成の続行をリクエストしました', loading: '続行できるか確認中…', unsupported: 'この DSH バージョンでは続行機能は有効ではありません。検証済みの DSH 0.2.2-rc.5 を使用してください。', unknown: '続行機能を確認できませんでした。リクエストは送信していません。', unavailable: '現在 DSH はこの失敗の続行を許可していません。コンピュータを確認するか、新しいメッセージを送信してください。', sending: '続行をリクエスト中…', queued: '続行が受理されました。会話の記録を待っています。', unconfirmed: '続行を確認できません。すでに始まった可能性があるため、再試行する前に会話を確認してください。', retry: '確認して同じリクエストを再試行', refresh: '再確認', draft: '続行する前に下書きと添付ファイルを消去してください。', offline: '続行するにはコンピュータに接続してください。' },
  ru: { ready: 'Продолжить генерацию', receipt: 'Запрошено продолжение генерации', loading: 'Проверка продолжения…', unsupported: 'Продолжение не включено для этой версии DSH. Используйте проверенную DSH 0.2.2-rc.5.', unknown: 'Не удалось проверить возможность продолжения. Запрос не отправлен.', unavailable: 'DSH сейчас не разрешает продолжить после этого сбоя. Проверьте компьютер или отправьте новое сообщение.', sending: 'Запрос продолжения…', queued: 'Продолжение принято. Ожидание записи хода.', unconfirmed: 'Продолжение не подтверждено. Проверьте чат перед повтором: оно могло уже начаться.', retry: 'Проверить и повторить тот же запрос', refresh: 'Проверить снова', draft: 'Перед продолжением очистите черновик и вложения.', offline: 'Для продолжения подключитесь к компьютеру.' },
}
export function continuationStrings(tag: string): Copy {
  const lang = tag.toLowerCase().split('-')[0]!
  return copies[lang === 'zh' && /-(hant|tw|hk|mo)(-|$)/i.test(tag) ? 'zh-Hant' : lang] ?? en
}
export const C: Copy = new Proxy({} as Copy, { get: (_, key) => { const l = language(); return continuationStrings(l === 'system' ? locale() : l)[key as keyof Copy] } })
