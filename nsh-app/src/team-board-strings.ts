// Independent feature dictionary: follows the app's language preference, including live changes.
import { locale } from 'nsh'
import { language } from './strings.ts'

const EN = {
  title: 'Team tasks', enabled: 'Teamwork on', disabled: 'Teamwork off', empty: 'No team tasks yet',
  pending: 'Pending', in_progress: 'In progress', completed: 'Completed', blocked: 'Blocked', ready: 'Ready',
  owner: 'Owner', unowned: 'Unassigned', dependencies: 'Dependencies', scopes: 'Write scopes', warnings: 'Write scope warnings',
  members: 'Members', loading: 'Loading team tasks…', unavailable: 'This host does not provide the team board.',
  error: 'Could not read team tasks.', stale: 'Offline or refresh failed. Showing the last received board.',
  failure: 'DSH rejected a team record. Tasks below are the last valid state.',
}
type Words = { [K in keyof typeof EN]: string }
const ZH: Words = {
  title: '团队任务', enabled: '团队协作已开启', disabled: '团队协作已关闭', empty: '暂无团队任务', pending: '待处理', in_progress: '进行中', completed: '已完成', blocked: '受阻', ready: '就绪',
  owner: '负责人', unowned: '未分配', dependencies: '依赖任务', scopes: '写入范围', warnings: '写入范围警告', members: '成员', loading: '正在加载团队任务…', unavailable: '此宿主不提供团队任务板。', error: '无法读取团队任务。', stale: '离线或刷新失败，显示上次收到的任务板。', failure: 'DSH 拒绝了一条团队记录。下方任务保留最后有效状态。',
}
const HANT: Words = {
  title: '團隊任務', enabled: '團隊協作已開啟', disabled: '團隊協作已關閉', empty: '暫無團隊任務', pending: '待處理', in_progress: '進行中', completed: '已完成', blocked: '受阻', ready: '就緒',
  owner: '負責人', unowned: '未分配', dependencies: '相依任務', scopes: '寫入範圍', warnings: '寫入範圍警告', members: '成員', loading: '正在載入團隊任務…', unavailable: '此主機不提供團隊任務板。', error: '無法讀取團隊任務。', stale: '離線或重新整理失敗，顯示上次收到的任務板。', failure: 'DSH 拒絕了一筆團隊記錄。下方任務保留最後有效狀態。',
}
const ES: Words = {
  title: 'Tareas del equipo', enabled: 'Trabajo en equipo activado', disabled: 'Trabajo en equipo desactivado', empty: 'Aún no hay tareas del equipo', pending: 'Pendiente', in_progress: 'En curso', completed: 'Completada', blocked: 'Bloqueada', ready: 'Lista',
  owner: 'Responsable', unowned: 'Sin asignar', dependencies: 'Dependencias', scopes: 'Ámbitos de escritura', warnings: 'Avisos de escritura', members: 'Miembros', loading: 'Cargando tareas…', unavailable: 'Este host no ofrece el tablero de equipo.', error: 'No se pudieron leer las tareas.', stale: 'Sin conexión o error al actualizar. Se muestra el último tablero recibido.', failure: 'DSH rechazó un registro del equipo. Se muestra el último estado válido.',
}
const FR: Words = {
  title: 'Tâches de l’équipe', enabled: 'Travail en équipe activé', disabled: 'Travail en équipe désactivé', empty: 'Aucune tâche d’équipe', pending: 'En attente', in_progress: 'En cours', completed: 'Terminée', blocked: 'Bloquée', ready: 'Prête',
  owner: 'Responsable', unowned: 'Non attribuée', dependencies: 'Dépendances', scopes: 'Périmètres d’écriture', warnings: 'Avertissements d’écriture', members: 'Membres', loading: 'Chargement des tâches…', unavailable: 'Cet hôte ne fournit pas de tableau d’équipe.', error: 'Impossible de lire les tâches.', stale: 'Hors ligne ou échec de l’actualisation. Dernier tableau reçu affiché.', failure: 'DSH a rejeté un enregistrement d’équipe. Les tâches restent au dernier état valide.',
}
const KO: Words = {
  title: '팀 작업', enabled: '팀워크 켜짐', disabled: '팀워크 꺼짐', empty: '아직 팀 작업이 없습니다', pending: '대기 중', in_progress: '진행 중', completed: '완료', blocked: '차단됨', ready: '준비됨',
  owner: '담당자', unowned: '미배정', dependencies: '선행 작업', scopes: '쓰기 범위', warnings: '쓰기 범위 경고', members: '구성원', loading: '팀 작업 불러오는 중…', unavailable: '이 호스트는 팀 보드를 제공하지 않습니다.', error: '팀 작업을 읽을 수 없습니다.', stale: '오프라인이거나 새로 고침에 실패했습니다. 마지막 보드를 표시합니다.', failure: 'DSH가 팀 기록을 거부했습니다. 마지막 유효한 작업 상태를 표시합니다.',
}
const JA: Words = {
  title: 'チームタスク', enabled: 'チームワーク有効', disabled: 'チームワーク無効', empty: 'チームタスクはまだありません', pending: '保留中', in_progress: '進行中', completed: '完了', blocked: 'ブロック中', ready: '準備完了',
  owner: '担当', unowned: '未割り当て', dependencies: '依存タスク', scopes: '書き込み範囲', warnings: '書き込み範囲の警告', members: 'メンバー', loading: 'チームタスクを読み込み中…', unavailable: 'このホストはチームボードを提供していません。', error: 'チームタスクを読み込めませんでした。', stale: 'オフラインまたは更新失敗。最後に受信したボードを表示しています。', failure: 'DSH がチーム記録を拒否しました。タスクは最後の有効な状態です。',
}
const RU: Words = {
  title: 'Задачи команды', enabled: 'Командная работа включена', disabled: 'Командная работа выключена', empty: 'Задач команды пока нет', pending: 'Ожидает', in_progress: 'В работе', completed: 'Завершена', blocked: 'Заблокирована', ready: 'Готова',
  owner: 'Ответственный', unowned: 'Не назначен', dependencies: 'Зависимости', scopes: 'Области записи', warnings: 'Предупреждения записи', members: 'Участники', loading: 'Загрузка задач…', unavailable: 'Этот хост не предоставляет доску команды.', error: 'Не удалось прочитать задачи.', stale: 'Нет связи или сбой обновления. Показана последняя полученная доска.', failure: 'DSH отклонил запись команды. Задачи сохранены в последнем корректном состоянии.',
}
export function teamStringsFor(tag: string): Words {
  const lang = tag.toLowerCase().split('-')[0]
  return lang === 'zh' ? /-(hant|tw|hk|mo)(-|$)/i.test(tag) ? HANT : ZH : lang === 'es' ? ES : lang === 'fr' ? FR : lang === 'ko' ? KO : lang === 'ja' ? JA : lang === 'ru' ? RU : EN
}
export const T: Words = new Proxy({} as Words, { get: (_, key) => { const l = language(); return teamStringsFor(l === 'system' ? locale() : l)[key as keyof Words] } })
