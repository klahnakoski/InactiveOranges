/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


// IMPORTANT VALUES OR FILTERS

var contributorFilter = {
    "and": [
        {
            "or": [
                {"exists": {"field": "bug_mentor"}},
                {"prefix": {"status_whiteboard.tokenized": "mentor"}},
                {"term": {"status_whiteboard.tokenized": "good first bug"}},
                {"term": {"status_whiteboard.tokenized": "good next bug"}},
                {"term": {"status_whiteboard.tokenized": "good_first_bug"}},
                {"term": {"status_whiteboard.tokenized": "good_next_bug"}}
            ]
        },
        {"terms": {"product": []}}
    ]
};


