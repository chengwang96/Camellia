'use strict';

function attachInputContextMenu(contents, { Menu, uiText }) {
  contents.on('context-menu', (_event, params) => {
    if (!params.isEditable && (!params.selectionText?.trim() || params.mediaType === 'image')) return;
    const flags = params.editFlags;
    const menu = Menu.buildFromTemplate([
      ...(params.isEditable ? [{ role: 'cut', label: uiText('Cut'), enabled: flags.canCut }] : []),
      { role: 'copy', label: uiText('Copy'), enabled: flags.canCopy },
      ...(params.isEditable ? [{ role: 'paste', label: uiText('Paste'), enabled: flags.canPaste }] : []),
      { role: 'selectAll', label: uiText('Select all'), enabled: flags.canSelectAll },
    ]);
    menu.popup({ frame: params.frame });
  });
}

module.exports = { attachInputContextMenu };
