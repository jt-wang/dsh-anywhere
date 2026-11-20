const keys = ['title', 'scope', 'group', 'workspace', 'workspace-tree', 'flat', 'order', 'manual', 'updated', 'filter', 'default', 'show', 'only', 'up', 'down'] as const
type Words = Record<typeof keys[number], string>
const translations: Record<string, string[]> = {
  en: ['Phone chat list', 'This is the sorting on your phone; it does not affect your computer.', 'Group by', 'Workspace', 'Workspace tree', 'Flat list', 'Order by', 'Manual', 'Last updated', 'Archived chats', 'Hide archived', 'Show archived', 'Archived only', 'Move up on this phone', 'Move down on this phone'],
  zh: ['手机聊天列表', '这是手机上的排序，不影响电脑。', '分组方式', '工作区', '工作区树', '平铺列表', '排序方式', '手动排序', '最近更新', '归档聊天', '隐藏归档', '显示归档', '仅归档', '仅在本机上移', '仅在本机下移'],
  'zh-Hant': ['手機聊天清單', '這是手機上的排序，不影響電腦。', '分組方式', '工作區', '工作區樹', '平鋪清單', '排序方式', '手動排序', '最近更新', '封存聊天', '隱藏封存', '顯示封存', '僅封存', '僅在本機上移', '僅在本機下移'],
  es: ['Lista de chats del teléfono', 'Este es el orden del teléfono; no afecta al ordenador.', 'Agrupar por', 'Espacio de trabajo', 'Árbol de espacios', 'Lista plana', 'Ordenar por', 'Manual', 'Última actualización', 'Chats archivados', 'Ocultar archivados', 'Mostrar archivados', 'Solo archivados', 'Subir solo en este teléfono', 'Bajar solo en este teléfono'],
  fr: ['Liste des discussions du téléphone', 'Ce tri s’applique au téléphone et n’affecte pas l’ordinateur.', 'Regrouper par', 'Espace de travail', 'Arborescence des espaces', 'Liste simple', 'Trier par', 'Manuel', 'Dernière mise à jour', 'Discussions archivées', 'Masquer les archives', 'Afficher les archives', 'Archives uniquement', 'Monter sur ce téléphone', 'Descendre sur ce téléphone'],
  ko: ['휴대폰 채팅 목록', '이 정렬은 휴대폰에만 적용되며 컴퓨터에는 영향을 주지 않습니다.', '그룹화', '작업 공간', '작업 공간 트리', '단일 목록', '정렬 기준', '수동', '최근 업데이트', '보관된 채팅', '보관 항목 숨기기', '보관 항목 표시', '보관 항목만', '이 휴대폰에서만 위로 이동', '이 휴대폰에서만 아래로 이동'],
  ja: ['スマートフォンのチャット一覧', 'これはスマートフォン上の表示順で、パソコンには影響しません。', 'グループ化', 'ワークスペース', 'ワークスペースツリー', 'フラット一覧', '表示順', '手動', '最終更新', 'アーカイブ済みチャット', 'アーカイブを非表示', 'アーカイブを表示', 'アーカイブのみ', 'この端末でのみ上へ移動', 'この端末でのみ下へ移動'],
  ru: ['Список чатов телефона', 'Это сортировка на телефоне; она не влияет на компьютер.', 'Группировка', 'Рабочая область', 'Дерево областей', 'Плоский список', 'Сортировка', 'Вручную', 'Последнее обновление', 'Архивные чаты', 'Скрыть архив', 'Показать архив', 'Только архив', 'Вверх только на этом телефоне', 'Вниз только на этом телефоне'],
}
export function workspaceViewStrings(tag: string): Words {
  const t = tag.toLowerCase(), key = /^zh-(hant|tw|hk|mo)(-|$)/.test(t) ? 'zh-Hant' : t.split('-')[0]!
  const values = translations[key] ?? translations.en!
  return Object.fromEntries(keys.map((key, index) => [key, values[index]!])) as Words
}
