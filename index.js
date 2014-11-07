var fs             = require('fs');
var path           = require('path');
var EventEmitter   = require('events').EventEmitter;
try {
  var fsevents = require('fsevents');
  console.log('watching with: fsevents');
} catch(e) {
  console.log('watching with: sane');
  var sane = require('sane');
}
var Promise        = require('rsvp').Promise;
var printSlowTrees = require('broccoli/lib/logging').printSlowTrees;

module.exports = Watcher;
function Watcher(builder, options) {
  this.builder = builder;
  this.options = options || {};
  this.watched = {};
  this.timeout = null;
  this.sequence = this.build();
}

Watcher.prototype = Object.create(EventEmitter.prototype);

// gathers rapid changes as one build
Watcher.prototype.scheduleBuild = function (filePath) {
  if (this.timeout) return;

  // we want the timeout to start now before we wait for the current build
  var timeout = new Promise(function (resolve, reject) {
    this.timeout = setTimeout(resolve, this.options.debounce || 100);
  }.bind(this));

  var build = function() {
    this.timeout = null;
    return this.build(filePath);
  }.bind(this);

  // we want the build to wait first for the current build, then the timeout
  function timoutThenBuild() {
    return timeout.then(build);
  }
  // we want the current promise to be waiting for the current build regardless if it fails or not
  // can't use finally because we want to be able to affect the result.
  this.sequence = this.sequence.then(timoutThenBuild, timoutThenBuild);
};

Watcher.prototype.build = function Watcher_build(filePath) {
  var addWatchDir = this.addWatchDir.bind(this);
  var triggerChange = this.triggerChange.bind(this);
  var triggerError = this.triggerError.bind(this);

  return this.builder
    .build(addWatchDir)
    .then(function(hash) {
      hash.filePath = filePath;
      return triggerChange(hash);
    }, triggerError)
    .then(function(run) {
      if (this.options.verbose) {
        printSlowTrees(run.graph);
      }

      return run;
    }.bind(this));
};


Watcher.prototype._saneWatcher = function(dir) {
  var watcher = new sane.Watcher(dir, {
    poll: !!this.options.poll
  });

  watcher.on('change', function(filePath,root) {
    this.onFileChanged(path.join(filePath, root));
  }.bind(this));

  watcher.on('create', function(filePath,root) {
    this.onFileAdded(path.join(filePath, root));
  }.bind(this));

  watcher.on('delete', function(filePath, root) {
    this.onFileDeleted(path.join(filePath, root));
  });

  return watcher;
};

Watcher.prototype._fsevents = function(dir) {
  var watcher = fsevents(dir);

  watcher.on('change', this.onFileChanged.bind(this));
  watcher.on('created', this.onFileAdded.bind(this));
  watcher.on('deleted', this.onFileDeleted.bind(this));
  watcher.start();

  return watcher;
};

Watcher.prototype.addWatchDir = function Watcher_addWatchDir(dir) {
  if (this.watched[dir]) return;

  if (!fs.existsSync(dir)) {
    throw new Error('Attempting to watch missing directory: ' + dir);
  }

  if (fsevents) {
    watcher = this._fsevents(dir);
  } else {
    watcher = this._saneWatcher(dir);
  }

  this.watched[dir] = watcher;
};

Watcher.prototype.onFileChanged = function (filePath, root) {
  if (this.options.verbose) console.log('file changed', filePath);
  this.scheduleBuild(filePath);
};

Watcher.prototype.onFileAdded = function (filePath, root) {
  if (this.options.verbose) console.log('file added', filePath);
  this.scheduleBuild(filePath);
};

Watcher.prototype.onFileDeleted = function (filePath, root) {
  if (this.options.verbose) console.log('file deleted', filePath);
  this.scheduleBuild(filePath);
};

Watcher.prototype.triggerChange = function (hash) {
  this.emit('change', hash);
  return hash;
};

Watcher.prototype.triggerError = function (error) {
  this.emit('error', error);
  throw error;
};

Watcher.prototype.close = function () {
  clearTimeout(this.timeout);
  var watched = this.watched;
  Object.keys(watched).forEach(function(dir) {
    var watcher = watched[dir];
    watcher.close ? watcher.close() : watcher.stop();
    delete watched[dir];
  });
};

Watcher.prototype.then = function(success, fail) {
  return this.sequence.then(success, fail);
};
