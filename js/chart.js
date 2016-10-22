importScript([
    "../modevlib/main.js",
    "review.js",
    "config.js",
    "../modevlib/layouts/layout.js"
], function () {
    layoutAll();

    var thread;
    var createChart = function () {
        var tempArray = [];
        GUI.state.teamFilter.forEach(function(element, index, array) {
            tempArray.push(element.toLowerCase());
        });
        contributorFilter.and[1].terms.product = tempArray;

        if (thread !== undefined)
            thread.kill();
        thread = Thread.run(__createChart());
    };

    var __createChart = function*() {
        var notAssigned = {
            "or": [
                {"term": {"assigned_to": "nobody@mozilla.org"}},
                {"regexp": {"assigned_to": ".*bugzilla\\.bugs"}}  // BUGZILLA HAS LOTS EMAILS THAT INDICATE nobody
            ]
        };

        var allBugs;
        var allBugsThread = Thread.run(function*() {
            allBugs = (yield(ESQuery.run({
                "select": "bug_id",
                "from": "public_bugs",
                "esfilter": {
                    "and": [
                        contributorFilter,
                        Mozilla.CurrentRecords.esfilter,
                        Mozilla.BugStatus.Open.esfilter
                    ]
                }
            }))).list.select("bug_id");
        });

        Thread.run(function*() {
            ///////////////////////////////////////////////////////////////////
            // PATCHES AND REVIEWS ARE DONE WITH SINGLE HIT TO ES
            ///////////////////////////////////////////////////////////////////
            var allPatches = yield (getPendingPatches(contributorFilter));

            var rawPatches = yield (Qb.calc2List({
                "from": allPatches,
                "select": [
                    {"name": "BugID", "value": "Bugzilla.linkToBug(bug.bug_id)"},
                    {"name": "Summary", "value": "bug.short_desc"},
                    {"name": "Mentor", "value": "bug.bug_mentor"},
                    {
                        "name": "Age (days)",
                        "value": "aMath.round(Date.eod().subtract(Date.newInstance(coalesce(modified_ts, attachment.modified_ts))).divideBy(Duration.DAY), 0)"
                    }
                ],
                "where": {
                    "and": [
                        {"missing": "reviewer"},
                        {"not": {"term": {"request_status": "+"}}}
                    ]
                },
                "sort": {"value": "Age (days)", "sort": -1}
            }));
            $("#patches").html(render(rawPatches));

            var pending = yield (Qb.calc2List({
                "from": allPatches,
                "select": [
                    {"name": "BugID", "value": "Bugzilla.linkToBug(bug.bug_id)"},
                    {"name": "Summary", "value": "bug.short_desc"},
                    {"name": "Reviewer", "value": "coalesce(reviewer, '')"},
                    {
                        "name": "Age (days)",
                        "value": "aMath.round(Date.eod().subtract(Date.newInstance(coalesce(modified_ts, attachment.modified_ts))).divideBy(Duration.DAY), 0)"
                    }
                ],
                "where": {
                    "and": [
                        {"exists": "reviewer"},
                        {"term": {"request_status": "?"}}
                    ]
                },
                "sort": {"value": "Age (days)", "sort": -1}
            }));
            $("#pendingReview").html(render(pending));

            var reviewMinus = yield (Qb.calc2List({
                "from": allPatches,
                "select": [
                    {"name": "BugID", "value": "Bugzilla.linkToBug(bug.bug_id)"},
                    {"name": "Summary", "value": "bug.short_desc"},
                    {"name": "Reviewer", "value": "reviewer"},
                    {
                        "name": "Age (days)",
                        "value": "aMath.round(Date.eod().subtract(Date.newInstance(coalesce(modified_ts, attachment.modified_ts))).divideBy(Duration.DAY), 0)"
                    }
                ],
                "where": {
                    "and": [
                        {"exists": {"field": "reviewer"}},
                        {"term": {"request_status": "-"}}
                    ]
                },
                "sort": {"value": "Age (days)", "sort": -1}
            }));
            $("#reviewMinus").html(render(reviewMinus));

            var complete = yield (Qb.calc2List({
                "from": allPatches,
                "select": [
                    {"name": "BugID", "value": "Bugzilla.linkToBug(bug.bug_id)"},
                    {"name": "Summary", "value": "bug.short_desc"},
                    {"name": "Reviewer", "value": "reviewer"},
                    {
                        "name": "Age (days)",
                        "value": "aMath.round(Date.eod().subtract(Date.newInstance(coalesce(modified_ts, attachment.modified_ts))).divideBy(Duration.DAY), 0)"
                    }
                ],
                "window": [
                    {
                        "name": "rejected",
                        "value": "request_status=='-' ? true : false",
                        "aggregate": "or",
                        "groupby": "BugID"
                    }
                ],
                "where": {
                    "and": [
                        {"term": {"request_status": "+"}},
                        {"not": {"terms": {"bug.bug_id": reviewMinus.list.select("BugID")}}},
                        {"not": {"contains": {"status_whiteboard": "leave open"}}}
                    ]
                },
                "sort": {"value": "Age (days)", "sort": -1}
            }));
            $("#completeReview").html(render(complete));


        });

        Thread.run(function*() {
            var oldest = Date.today().addMonth(-1);

            var churn = yield (ElasticSearch.getMinMax({
                "and": [
                    contributorFilter,
                    {"range": {"modified_ts": {"gte": oldest.getMilli()}}},
                    notAssigned
                ]
            }));

            var parts = churn.edges[0].domain.partitions;
            var newBugIDs = churn.cube.forall(function (v, i) {
                v.bug_id = parts[i].value;
            }).filter(function (v) {
                return v.min > oldest && v.max === undefined
            });

            var newBugs = yield(ESQuery.run({
                "select": ["bug_id", "short_desc", "modified_ts", "bug_mentor", "status_whiteboard"],
                "from": "public_bugs",
                "esfilter": {
                    "and": [
                        {"terms": {"bug_id": newBugIDs.select("bug_id")}},  //THE bug_ids
                        Mozilla.CurrentRecords.esfilter,
                        Mozilla.BugStatus.Open.esfilter
                    ]
                }
            }));

            var output = yield (Qb.calc2List({
                "from": newBugs,
                "select": [
                    {"name": "BugID", "value": "Bugzilla.linkToBug(bug_id)"},
                    {"name": "Summary", "value": "short_desc"},
                    {
                        "name": "Mentor",
                        "value": "coalesce(bug_mentor, coalesce(status_whiteboard, '').between('[mentor=', ']'))"
                    },
                    {
                        "name": "Age (weekdays)",
                        "value": "Math.round(Date.diffWeekday(Date.eod(), Date.newInstance(modified_ts)))"
                    }
                ],
                "sort": {"value": "Age (weekdays)", "sort": -1}
            }));

            $("#newBugs").html(render(output))

        });


        Thread.run(function*() {
            var noBites = yield(ESQuery.run({
                "select": ["bug_id", "short_desc", "modified_ts", "bug_mentor", "status_whiteboard"],
                "from": "public_bugs",
                "esfilter": {
                    "and": [
                        contributorFilter,
                        Mozilla.CurrentRecords.esfilter,
                        Mozilla.BugStatus.Open.esfilter,
                        {"range": {"modified_ts": {"lt": Date.today().addMonth(-3).getMilli()}}},
                        notAssigned
                    ]
                }
            }));

            var output = yield (Qb.calc2List({
                "from": noBites,
                "select": [
                    {"name": "BugID", "value": "Bugzilla.linkToBug(bug_id)"},
                    {"name": "Summary", "value": "short_desc"},
                    {
                        "name": "Mentor",
                        "value": "coalesce(bug_mentor, coalesce(status_whiteboard, '').between('[mentor=', ']'))"
                    },
                    {
                        "name": "Age (days)",
                        "value": "aMath.round(Date.eod().subtract(Date.newInstance(modified_ts)).divideBy(Duration.DAY), 0)"
                    }
                ],
                "sort": {"value": "Age (days)", "sort": -1}
            }));

            $("#noBites").html(render(output))

        });

        Thread.run(function*() {
            var staleBugs = yield(ESQuery.run({
                "select": ["bug_id", "short_desc", "modified_ts", "bug_mentor", "status_whiteboard"],
                "from": "public_bugs",
                "esfilter": {
                    "and": [
                        contributorFilter,
                        Mozilla.CurrentRecords.esfilter,
                        Mozilla.BugStatus.Open.esfilter,
                        {"range": {"modified_ts": {"lt": Date.today().addDay(-7).getMilli()}}},
                        {"not": notAssigned}
                    ]
                }
            }));

            var output = yield (Qb.calc2List({
                "from": staleBugs,
                "select": [
                    {"name": "BugID", "value": "Bugzilla.linkToBug(bug_id)"},
                    {"name": "Summary", "value": "short_desc"},
                    {
                        "name": "Mentor",
                        "value": "coalesce(bug_mentor, coalesce(status_whiteboard, '').between('[mentor=', ']'))"
                    },
                    {
                        "name": "Age (weekdays)",
                        "value": "Math.round(Date.diffWeekday(Date.today(), Date.newInstance(modified_ts)))"
                    }
                ],
                "sort": {"value": "Age (weekdays)", "sort": -1}
            }));

            $("#staleBugs").html(render(output))

        });

        Thread.run(function*() {
            yield (allBugsThread.join());
            var questions = yield (findQuestions(allBugs));

            var openQuestion = yield(ESQuery.run({
                "from": "public_bugs",
                "select": ["bug_id", "short_desc", "modified_ts", "bug_mentor", "status_whiteboard"],
                "esfilter": {
                    "and": [
                        contributorFilter,
                        Mozilla.CurrentRecords.esfilter,
                        Mozilla.BugStatus.Open.esfilter,
                        {"range": {"modified_ts": {"lt": Date.today().addDay(-2).getMilli()}}},
                        {
                            "or": [
                                {
                                    "nested": {
                                        "path": "flags",
                                        "query": {
                                            "filtered": {
                                                "query": {
                                                    "match_all": {}
                                                },
                                                "filter": {
                                                    "and": [
                                                        {"term": {"flags.request_type": "needinfo"}},
                                                        {"term": {"flags.request_status": "?"}}
                                                    ]
                                                }
                                            }
                                        }
                                    }
                                },
                                {"terms": {"bug_id": questions.select("bug_id")}}
                            ]
                        }
                    ]
                }
            }));

            var output = yield (Qb.calc2List({
                "from": openQuestion,
                "select": [
                    {"name": "BugID", "value": "Bugzilla.linkToBug(bug_id)"},
                    {"name": "Summary", "value": "short_desc"},
                    {
                        "name": "Mentor",
                        "value": "coalesce(bug_mentor, coalesce(status_whiteboard, '').between('[mentor=', ']'))"
                    },
                    {
                        "name": "Age (days)",
                        "value": "aMath.round(Date.eod().subtract(Date.newInstance(modified_ts)).divideBy(Duration.DAY), 0)"
                    }
                ],
                "sort": {"value": "Age (days)", "sort": -1}
            }));

            $("#openQuestion").html(render(output));


        });
    };//createChart

    var findBugs = function() {
        GUI.setup(
          createChart,
          [
              {"id" : "teamFilter", "name" : "Team", "type" : "set", "default": "Firefox for Android"}
          ],
          [],
          null,
          false,		//SHOW DEFAULT FILTERS?
          false,
          false        //DISABLE showLastUpdated
        );
    };

    $(document).ready(function() {
        findBugs();
    });
});
