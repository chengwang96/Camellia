'use strict';

function attachInputContextMenu(contents, { Menu, uiText }) {
  contents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    const flags = params.editFlags;
    const menu = Menu.buildFromTemplate([
      { role: 'cut', label: uiText('Cut'), enabled: flags.canCut },
      { role: 'copy', label: uiText('Copy'), enabled: flags.canCopy },
      { role: 'paste', label: uiText('Paste'), enabled: flags.canPaste },
      { role: 'selectAll', label: uiText('Select all'), enabled: flags.canSelectAll },
    ]);
    menu.popup({ frame: params.frame });
  });
}

module.exports = { attachInputContextMenu };
