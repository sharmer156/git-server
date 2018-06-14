/*
 *  Copyright 2018 Adobe Systems Incorporated. All rights reserved.
 *  This file is licensed to you under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License. You may obtain a copy
 *  of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software distributed under
 *  the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 *  OF ANY KIND, either express or implied. See the License for the specific language
 *  governing permissions and limitations under the License.
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');
const { Transform } = require('stream');

const fse = require('fs-extra');
const mime = require('mime');
const Git = require('nodegit');

/**
 * Transform stream skipping blob header 'blob <length>\0'
 */
class SkipBlobHeader extends Transform {
  constructor(options) {
    super(options);
    this._skipped = false;
  }

  _transform(chunk, encoding, cb) {
    if (!this._skipped) {
      // read past blob header '
      const off = chunk.indexOf(0);
      if (off === -1) {
        return cb();
      }
      this._skipped = true;
      return cb(null, chunk.slice(off + 1));
    }
    cb(null, chunk);
  }
}

function calculateBlobSha1(data) {
  return crypto.createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex');
}

/**
 * Export the raw content handler (express middleware) through a parameterizable function
 *
 * @param {object} options configuration hash
 * @returns {function(*, *, *)} handler function
 */
module.exports = function (options) {
  /**
   * Express middleware handling raw content requests
   *
   * @param {Request} req Request object
   * @param {Response} res Response object
   * @param {callback} next next middleware in chain
   */
  return (req, res, next) => {
    const owner = req.params.owner;
    const repoName = req.params.repo;
    const refName = req.params.ref;
    const fpath = req.params[0];

    // TODO handle branch names containing '/' (e.g. 'foo/bar')

    const repPath = path.resolve(options.repoRoot, owner, repoName);
    let _repo;
    Git.Repository.open(repPath)
      .then(repo => {
        _repo = repo;
        return repo.getReference(refName)
          .then(ref => {
            return ref.peel(Git.Object.TYPE.COMMIT);
          })
          .then(obj => {
            return Git.Commit.lookup(_repo, obj.id());
          })
          .catch(() => {
            // ref => commit id?
            // return _repo.getCommit(ref);
            // support shorthand commit id's
            return Git.AnnotatedCommit.fromRevspec(_repo, refName)
              .then(annCommit => _repo.getCommit(annCommit.id()));
          });
      })
      .then(commit => {
        return commit.getEntry(fpath);
      }).then(entry => {
        return entry.getBlob();
      })
      .then(blob => {
        // issue #150: check for modified local file content
        return Git.Blob.createFromWorkdir(_repo, fpath)
          .then(oid => {
            if (!oid.equal(blob.id())) {
              // serve local file
              return Git.Blob.lookup(_repo, oid);
            } else {
              return blob;
            }
          });        
      })
      .then(blob => {
        const mimeType = mime.getType(fpath) || 'plain/text';
        const sha1 = blob.id().tostrS();
        res.writeHead(200, {
          'content-type': mimeType,
          'etag': sha1,
          // TODO review cache-control header
          'cache-control': 'max-age=0, private, must-revalidate'
        });
        const blobPath = path.join(repPath, '.git/objects', sha1.substr(0, 2), sha1.substr(2));
        fse.exists(blobPath)
          .then(exists => {
            if (exists) {
              // stream blob content directly from git's loose object store on file system
              fse.createReadStream(blobPath).pipe(zlib.createInflate()).pipe(new SkipBlobHeader()).pipe(res);
            } else {
              // fallback: refs are probably packed, let nodegit handle/resolve packed-refs
              res.end(blob.isBinary() ? blob.content() : blob.toString());
            }
          });
      })
      .catch(err => {
        // TODO return specific status (404, 500, etc)
        next(err);
      })
      .finally(() => {
        // TODO cache Repository instances (key: absolute path)
        _repo.free();
      });
  };
};