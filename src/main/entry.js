'use strict';

if (process.argv.includes('--camellia-directory-progress')) {
  require('./data-directory-progress').showDirectoryMigrationProgress().catch(error => {
    console.error(error);
    require('electron').app.exit(1);
  });
} else {
  const { app, dialog } = require('electron');
  try {
    // Recover before profile selection can create a new, empty old directory.
    const directories = require('./data-directory');
    if (directories.usesManagedDataDirectory(app)) directories.recoverDirectoryMigration(app.getPath('appData'));
    require('./main');
  } catch (error) {
    console.error('Camellia startup: ' + error.message);
    if (error.code === 'CAMELLIA_MIGRATION_BUSY') app.exit(0);
    else app.whenReady().then(() => {
      dialog.showErrorBox('Camellia', error.message);
      app.exit(1);
    });
  }
}
