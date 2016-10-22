/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function*getReviewers(timeDomain, maxReviewers){
	maxReviewers = coalesce(maxReviewers, 100);

	var persons = [];

	var allEmails = GUI.state.emails.split(",").map(String.trim);
	var allSelected = (yield(GUI.state.teamFilter.getAllSelectedPeople()));

	if (allSelected.length == 0 && allEmails.length == 0) {
		Log.alert("Must select a team", function(){
		});
		Log.error("No team selected");
	}//endif

	allSelected.forall(function(p){
		p = Map.copy(p);
		p.id = p.id.deformat();
		p.email = Array.newInstance(p.email);
		p.esfilter = {"terms" : {"reviewer" : p.email}};
		persons.append(p);

		allEmails = allEmails.subtract(p.email)
	});
	allEmails.forall(function(e){
		p = {
			"id" : e.deformat(),
			"name" : e,
			"email" : Array.newInstance(e),
			"esfilter" : {"term" : {"reviewer" : e}}
		};
		persons.append(p);
	});


	var domain = {"type" : "set", "key" : "name", "isFacet" : true, "partitions" : [
		{"name" : "pending", "esfilter" : {"missing" : {"field" : "review_time"}}},
		{"name" : "done", "esfilter" : {"and" : [
			{"exists" : {"field" : "review_time"}},
			{"range" : {"review_time" : {"gte" : timeDomain.min.getMilli(), "lt" : timeDomain.max.getMilli()}}}
		]}}
	]};


	var reviewers = yield (ESQuery.run({
		"from" : "reviews",
		"select" : {"name" : "count", "value" : "bug_id", "aggregate" : "count"},
		"edges" : [
			{"name" : "type", "domain" : domain},
			{"name" : "reviewer", "domain" : {"type" : "set", "key" : "id", "partitions" : persons, "isFacet" : true}}
		],
		"esfilter" : {"and" : [
			{"or" : [
				{"missing" : {"field" : "review_time"}},
				{"and" : [
					{"range" : {"review_time" : {"gte" : timeDomain.min.getMilli()}}}
//					{"terms" : {"review_result" : ["+", "-"]}}
				]}
			]},
			{"terms" : {"request_type" : ["review", "superreview"]}},
			{"terms" : {"reviewer" : Array.union(persons.select("email"))}}
		]}
	}));


	//SORT REVIEWERS BY count
	//THIS IS WHAT WE WOULD HAVE LIKED TO DO
	//reviewers=yield(Q({
	//	"from":reviewers,
	//	"sort":{"reviewer":{"value":"count", "sort":-1, "aggregate":"sum", "where":{"term":{"type":"done"}}}}
	//}));
	var ordered = Qb.sort(Qb.Cube2List(reviewers).filter({"term" : {"type.name" : "done"}}), {"value" : "count", "sort" : -1});
	var old_parts = reviewers.edges[1].domain.partitions;
	var new_parts = [];
	var new_cube = reviewers.cube.map(function(){
		return [];
	});

	for (var n = 0; n < aMath.min(ordered.length, maxReviewers); n++) {
		var nn = ordered[n].reviewer;
		for (var o = 0; o < old_parts.length; o++) {
			var oo = old_parts[o];
//			oo.esfilter = {"terms" : {"reviewer" : oo.email}};
			if (nn == oo) {
				new_parts[n] = oo;
				for (var j = 0; j < new_cube.length; j++) {
					new_cube[j][n] = reviewers.cube[j][o];
				}//for
				break;
			}//endif
		}//for
	}//for
	reviewers.edges[1].domain.partitions = new_parts;
	reviewers.cube = new_cube;

	yield reviewers;
}


function* getPendingPatches(mainFilter){
	var a = Log.action("Get bugs with patches", true);

	///////////////////////////////////////////////////////////////////////////
	// PULL OUT ALL RECENT BUGS THAT HAVE A PENDING REVIEW
	///////////////////////////////////////////////////////////////////////////
	var bugs = yield (ESQuery.run({
		"from" : "public_bugs",
		"select" : ["bug_id", "short_desc", "bug_mentor", "attachments", "status_whiteboard"],
		"esfilter" : {"and" : [
			{"range" : {"expires_on" : {"gt" : Date.eod().getMilli()}}},
			Mozilla.BugStatus.Open.esfilter,
			{ "nested" : {
				"path" : "attachments",
				"query" : {
					"filtered" : {
						"query" : {
							"match_all" : {}
						},
						"filter" : {"and" : [
							{"term" : {"attachments.isobsolete" : 0}},
							{"or" : [
								{"term" : {"attachments.ispatch" : 1}},
								{"terms" : {"attachments.flags.request_type" : ["review", "superreview"]}}
							]}
						]}
					}
				}
			}},
			mainFilter
		]}
	}));

	Log.actionDone(a);

	///////////////////////////////////////////////////////////////////////////
	// FILTER OUT JUST THE FLAGS THAT REPRESENT REVIEWS (OR RAW PATCH)
	///////////////////////////////////////////////////////////////////////////
	var allPatches = [];
	bugs.list.forall(function(b){
		b.attachments.forall(function(a){
			var flags = Array.newInstance(a.flags);
			if (flags.length == 0) flags.append({});
			a.flags = undefined;

			flags.forall(function(f){
				if (
					(
						["review", "superreview"].contains(f.request_type) ||
							a.ispatch == 1
						) &&
						a.isobsolete == 0
				) {
					f.bug = b;
					f.attachment = a;
					f.reviewer = coalesce(f.requestee);
					f.request_time = coalesce(f.modified_ts, a.modified_ts);
					allPatches.append(f);
				}//endif
			});
		});
		b.attachments = undefined;
	});

	yield allPatches;
}


function* findQuestions(bugList){

	var comments = yield(ESQuery.run({
		"from":"public_comments",
		"select":["bug_id", "modified_by", "modified_ts", "comment"],
		"esfilter":{"and":[
			{"terms":{"bug_id":bugList}},
			{"range":{"modified_ts":{"gte":Date.today().addMonth(-3).getMilli()}}}
		]}
	}));

	//GET THE OLDEST COMMENT FROM EACH BUG
	var oldest={};
	comments.list.forall(function(c){
		var old = oldest[c.bug_id];
		if (old===undefined){
			oldest[c.bug_id]=c;
			old = c;
		}else if (old.modified_ts< c.modified_ts){
			oldest[c.bug_id]=c;
			old = c;
		}//endif
	});

	var questions = Map.getValues(oldest).filter(function(c){
		//FIND A QUESTION (?), BUT NOT IN A QUOTE (>)
		return c.comment.split("\n").map(function(line){
			if (line.trim().startsWith(">")) return undefined;
			line=line+" ";

			while(true) {
				var url = findURL(line);
				if (url) {
					line = line.replace(url, "");
				}else{
					break;
				}//endif
			}//while

			if (line.indexOf("?")>=0) return c;
		}).first();
	});
	yield questions;
}


function findURL(line){
	var url = line.between("http://", " ");
	if (url) return "http://"+url;
	url = line.between("https://", " ");
	if (url) return "https://"+url;
	return null;
}//method



doneBugs={};
function render(bugs){
	//SHOW BUGS ONLY ONCE
	bugs = coalesce(bugs.list, bugs).map(function(b){
		if (doneBugs[b.BugID.html]) return undefined;
		doneBugs[b.BugID.html]=true;
		return b;
	});
	return convert.List2HTMLTable(bugs);

}//method
