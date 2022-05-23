/* eslint-disable no-undef */
import 'mocha';
import { assert } from 'chai';
import { removeOverheadFromCopyright, insertCopyrightIntoBom, hasLicense, hasExternalRefs, filterRepoInfoFromURL } from '../src/copyright.js';


describe('removeOverheadFromCopyright', function () {
    it('should remove html tags', function () {
        assert.equal(removeOverheadFromCopyright('Copyright <div> 2019 </div> Max Mustermann'), 'Copyright 2019 Max Mustermann');
        assert.equal(removeOverheadFromCopyright('<http://website.de> Hello <> World'), 'Hello World');
        assert.equal(removeOverheadFromCopyright('<This should be removed>'), '');
    });

    it('should remove text enclosed by parenthesis', function () {
        assert.equal(removeOverheadFromCopyright('Copyright Test Owner (test-owner@domain.com)'), 'Copyright Test Owner');
        assert.equal(removeOverheadFromCopyright('() Copyright'), 'Copyright');
    });

    it('should preserve the (c) symbol', function () {
        assert.equal(removeOverheadFromCopyright('(c) Copyright'), '(c) Copyright');
        assert.equal(removeOverheadFromCopyright('(ccc) Copyright (C)'), 'Copyright (C)');
    });

    it('should remove all unnecessary whitespace', function () {
        assert.equal(removeOverheadFromCopyright('  first  (c)    second   '), 'first (c) second');
        assert.equal(removeOverheadFromCopyright('<  >  () copyright '), 'copyright');
    });
});

describe('insertCopyrightIntoBom', function () {
    let packageInfo = {
        'licenses': [
            {
                'license': {
                    'id': 'MIT',
                    'url': 'https://opensource.org/licenses/MIT'
                }
            }
        ]
    };
    it('should add an entry containing the copyright notice into the bom', function () {
        assert.equal(insertCopyrightIntoBom(packageInfo, 'Copyright notice')['licenses'][0]['license']['copyright'], 'Copyright notice');
    });
});

describe('hasLicense', function () {
    let packageInfo = {
        'licenses': [
            {
                'license': {
                    'id': 'MIT',
                    'url': 'https://opensource.org/licenses/MIT'
                }
            }
        ]
    };
    it('should return whether license information are available for the given package', function () {
        assert.isTrue(hasLicense(packageInfo));
        packageInfo['licenses'] = [];
        assert.isFalse(hasLicense(packageInfo));
    });
});

describe('hasExternalReferences', function () {
    let packageInfo = {
        'externalReferences': [
            {
                'type': 'website',
                'url': 'https://github.com/readme'
            },
            {
                'type': 'vcs',
                'url': 'git+https://github.com/plugins.git'
            }
        ],
    };
    it('should return whether external references are available for the given package', function () {
        assert.isTrue(hasExternalRefs(packageInfo));
        packageInfo['externalReferences'] = [];
        assert.isFalse(hasExternalRefs(packageInfo));
    });
});

describe('filterRepoInfoFromURL', function () {
    it('should correctly extract the user and repository from the given url', function () {
        assert.equal(filterRepoInfoFromURL('github.com/user/repo')[0], 'user');
        assert.equal(filterRepoInfoFromURL('github.com/user/repo')[1], 'repo');
        assert.equal(filterRepoInfoFromURL('http://www.github.com/user-name/repo.name')[0], 'user-name');
        assert.equal(filterRepoInfoFromURL('http://www.github.com/user-name/repo.name')[1], 'repo.name');
    });
    it('should remove subdirectories and fragments', function () {
        assert.equal(filterRepoInfoFromURL('github.com/user/repo/sub/directory.git')[0], 'user');
        assert.equal(filterRepoInfoFromURL('github.com/user/repo/sub/directory.git')[1], 'repo');
        assert.equal(filterRepoInfoFromURL('github.com/user/repo/sub#readme')[0], 'user');
        assert.equal(filterRepoInfoFromURL('github.com/user/repo/sub#readme')[1], 'repo');
    });
});