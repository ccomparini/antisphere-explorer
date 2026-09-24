"use strict"

/**
  uiulator - a simple way to display javascript state in html.

  How to use this:

   - Lay out your html as you like.  Mark elements on which you'd
     like to display data with "data-shows".  Mark elements which
     you want to use to set data with "data-controls", etc (see
     below).

   - apply the uiulator something like:
       var my_data = { x: 1, y: 2 }; // or whatever
       var uu = uiulator(my_data, document.querySelectorAll(".uistuffs"));
       uu.update();  // refresh the display. (typically call this from an event)

     uiulator can take a list of elements or a single element.

  There are 4 element "markers" which determine how the data are
  controlled or displayed:
    - data-shows=<member>    - show the named member of the scope
    - data-expands=<member>  - duplicate for each item in the member
    - data-controls=<member> - set the named member from the value
                               or content of the element
    - data-scope=<member>    - set the scope for all 
    - data-shows-if=<member> - shows element if member is true in scope
    - data-shows-unless=<member> - shows element if member is false in scope

  For all the above markers, if the member is unspecified (empty string),
  the current scope is used.  "Current scope", in this context, is
  either the "dataSource" passed to the uiulator, or whatever sub
  object within was selected by data-scope, or the current item
  in a data-expands.

  Additionally, the special "member" '@key' may be used in "data-shows"
  and "value" to specify the expanded key.  This is useful for setting
  setting values for things like <option> or <button> tags.

  See the example*.html files for examples.

 */

/**
   uiulator(dataSource)
   uiulator(dataSource, elements)
   uiulator(dataSource, elements, options)

   Applies uiular rules to the specified elements, using data from the
   dataSource passed.

   Parameters:
     - dataSource: A javascript variable (typically an array or object, but
                   may be a scalar value) to be displayed on and/or set from
                   the indicated elements.
     - elements:   The set of root elements to which to apply the uiulator.
                   May be sepcified as a single Element or an array of
                   Elements.  If not specified, the global document is used.
                   https://developer.mozilla.org/en-US/docs/Web/API/Element
     - options:    An object with 0 or more of the following:
                   - 'control-on-submit': <boolean>
                     If true, only modify the dataSource when it appears the
                     user has "submitted" the data (typically on a 'change'
                     event).  Otherwise (of false or omitted), data in the
                     dataSource may be modified as soon as any change is
                     detected (eg as the user is typing).
                   - oncontrolchanged: <function (ev, elem, container, var, old)>
                     Causes the specified function to be called after a
                     data-control makes a change to data.  Parameters:
                       - ev: the Event which precipitated the change
                       - elem: the data-control Element which made the change
                       - container: the containing scope of the changed var
                       - var: the name of the variable which was changed
                       - old: the old value of the variable
                     The function will be called after the element's events
                     have been handled.
                   - poll-interval: <numeric milliseconds>
                     If specified, a timer will be scheduled to call update()
                     on the specified interval.
                   - 'update-on-change': <boolean>
                     If true, call update() any time a change is detected on
                     an element marked with data-controls.

                   If neither poll-interval nor update-on-change are set,
                   it's up to callers to make sure update() is called
                   as necessary.

 */
var uiulator = function(dataSource, elements, options) {

    options ||= { };

    // if no elements were specified, do them all!  This is typically
    // a one-off, so I'm not too worried about performance.  If callers
    // are concerned, then can narrow the scope themselves.
    if(typeof elements === "undefined") {
        elements = [ document ];
    }

    // support single elements as well as array:
    if(typeof elements.forEach === "undefined") {
        // .. err.. and it turns out an htmlCollection isn't like
        // an array.  but let's attempt to support it, even though
        // browsers and js (naturally) will try to thwart us:
        let elst = Object.prototype.toString.call(elements);
        if(/HTMLCollection/.test(elst)) {
            // looks like it's probably an HTML collection:
            elements = Array.prototype.slice.call(elements);
        } else {
            // it's some kind of single object.  create a one
            // element array to hold it so that we can just deal
            // with arrays from here out:
            elements = [ elements ];
        }
    }

    // This is the order in which element markers are applied:
    // "data-scope" (and "data-expands") adjust the scope for
    // the current element (and all child elements) before
    // anything else, and "data-shows" must come last so that
    // it always shows the latest state.
    const controlOrder = [
        "scope",
        "showsIf",
        "showsUnless",
        "classIf",
        "expands",
        "controls",
        "shows",
    ];

    // these are for stashing data in expander elements:
    const origStyles     = Symbol();
    const generatedElems = Symbol();
    const noSplatValue   = Symbol();
    const noSplatText    = Symbol();

    // and this is for updaters (or anything else
    // which wants access more directly to the thing
    // being shown)
    const nowShowing = Symbol();

    // returns an object with:
    //  - varPath:  array of keys representing nested members in data
    //  - scale: optional amount to scale the data by
// is scale ever used??
    function parseVarSpec(vs) {
        const result = { varPath: [ ] };
        if(vs !== undefined) {
            let ppart;
            [ ppart, result.scale ] = vs.split('*');

            // split the path string on '.' to get the steps we'll
            // follow to find the specific submember in the provided
            // data:
            if(ppart.length) {
                result.varPath = ppart.split('.');
            }

            // convert the scale to numeric:
            if(result.scale !== undefined) {
                result.scale = Number.parseFloat(result.scale);
            }
        }
        return result;
    }

    function evaluate(data, spec) {
        if(data === undefined || spec === undefined)
            return data;

        for(const varr of spec.varPath) {
            if(data[varr] == undefined)
                return undefined;

            data = data[varr];
        }

        if(spec.scale !== undefined)
            data = data*spec.scale;

        return data;
    }

    function rescopeClone(clone, key) {
        // change the id of the clone, or else it inherits
        // the id and we get duplicate ids:
        if(clone.id !== "")
            clone.id = clone.id + "-" + key;

        if(clone.value === '@key') {
            clone.value = key;
            clone[noSplatValue] = true;
        }

        if(clone.dataset?.shows === '@key') {
            clone.innerText     = key;
            clone.dataset.shows = "";  // grrr dubious
            clone[noSplatText] = true;
        }

        for(const kid of clone.childNodes) {
            rescopeClone(kid, key);
        }
    }

    function cloneAndExpand(elem, data, key) {
        let newElem = elem.cloneNode(true);
        rescopeClone(newElem, key);

        for(const stel in elem[origStyles]) {
            newElem.style[stel] = elem[origStyles][stel];
        }

        // OK so here's how we'll do it: the new element gets
        // scoped according to the key passed:
        newElem.dataset.scope = key;
        elem.parentElement.insertBefore(newElem, elem);

        return newElem;
    }

    function restoreStyle(elem) {
        if(elem[origStyles]) {
            for(const stel in elem[origStyles]) {
                elem.style[stel] = elem[origStyles][stel];
            }
        }
    }

    function setExpanderStyle(elem, styleOverride) {
        if(!elem[origStyles]) {
            elem[origStyles] = { };
        }

        for(const key in styleOverride) {
            if(!(key in elem[origStyles]))
                elem[origStyles][key] = elem.style[key];
            elem.style[key] = styleOverride[key];
        }
    }


    // schedules the function passed to be run after
    // element events (onchange etc) have fired
    function afterEvents(fun) {
        setTimeout(fun);
    }

    function onControlModified(ev) {
        const elem = ev.target;
        const data = elem[nowShowing];
        const vs = parseVarSpec(elem.dataset.shows);
        const specificVar = vs.varPath.pop();
        const container = evaluate(data, vs);
        if(container === undefined) {
            console.warn(
                `Can't set ${vs.varPath}[${specificVar}] because it's undefined`
            );
        } else {
            var oldVal = container[specificVar];
            if(elem.type === "checkbox") {
                // checkboxes, too, are special:
                container[specificVar] = elem.checked;
            } else if(elem.type === "number" || elem.type === "range") {
                const n = elem.valueAsNumber;
                if(Number.isNaN(n))
                    // mid-edit, e.g. the field was cleared
                    return;
                container[specificVar] = n;
            } else if(elem.value !== undefined) {
                container[specificVar] = elem.value;
            } else {
                container[specificVar] = elem.innerText;
            }
        }

        if(options['update-on-change']) {
            afterEvents(() => { updateDisplays(); });
        }

        if(options['oncontrolchanged']) {
            afterEvents(() => {
                options['oncontrolchanged'](
                    ev, elem, container, specificVar, oldVal
                );
            });
        }
    }

    function isValueWritable(elem) {
        return elem.value !== undefined && !elem[noSplatValue];
    }

    function isTextWritable(elem) {
        return !elem[noSplatText];
    }

    function doShow(elem, val) {
        if(elem.type === "radio") {
            // Radio buttons are special because there's one
            // value being shown/controlled by multiple elements,
            // but each of those elements has a (constant) "value"
            // it sets when selected.  So, it should be selected
            // if the value matches, but the value of the radio
            // button should -not- be changed, since that would
            // just set all the radio button values to the current
            // value.  :D
            elem.checked = val === elem.value;
        } else if(elem.type === "checkbox") {
            // gar checkboxes are an exception as well. sigh
            elem.checked = !!val;
        } else if(elem.tagName === "OPTION") {
            // OK <option>s are also special.  They need both
            // the value and some kind of content set.  grr.
            if(isValueWritable(elem))
                elem.value = val;
            if(isTextWritable(elem))
                elem.textContent = val;
        } else if(elem.tagName === "LI") {
            // yay apparently more tags are special.  <li>
            // seems to have a value attribute, and it seems
            // to do nothing.  So in the <li> case, we force
            // textContent:
            if(isTextWritable(elem))
                elem.textContent = val;
        } else {
            // don't change the active element - it's very annoying
            // for users if they are trying to copy and paste or type
            // something in and you change it:
            if(document.activeElement !== elem) {
                if(isValueWritable(elem)) {
                    // inputs/controls, typically:
                    elem.value = val;
                } else if(isTextWritable(elem)) {
                    // normal div or span or whatever
                    elem.textContent = val;
                }
            }
        }
    }

    // given an integer, returns an iterable object
    // with the values [0..integer] (inclusive)
    function iterableInteger(integer) {
      return function*() {
        let index = 0;
        while(index < integer) {
          yield index++;
        }
      }();
    }

    function expanderKeys(data) {

        if(typeof(data) === 'number') {
            // we've been given a number, so it basically means
            // "repeat that many times".  create a generator
            // which generates a sequence of that length (rounded
            // to nearest):
            return iterableInteger(Math.round(data));
        }

        return Object.keys(data);
    }

    function showIf(elem, data, val) {
        if(val) {
            restoreStyle(elem);
            return [ elem, data ];
        } else {
            setExpanderStyle(elem, { display: 'none' });
            // ... and also stop doing children:
            return [ undefined, undefined ];
        }
    }

    // update functions, by name:
    const upFunc = {
        scope: function(elem, data, vs) {
            // continue on elem with new data;
            // data = evaluate data[vs] sets the actual scope
            return [ elem, evaluate(data, parseVarSpec(vs)) ];
        },
        showsIf: function(elem, data, vs) {
            return showIf(elem, data, evaluate(data, parseVarSpec(vs)));
        },
        showsUnless: function(elem, data, vs) {
            return showIf(elem, data, !evaluate(data, parseVarSpec(vs)));
        },
        classIf: function(elem, data, vs) {
            // "cls" | "cls:member" | "cls:!member", comma-separated
            for(const clause of vs.split(',')) {
                let [cls, member] = clause.split(':').map((s) => s.trim());
                if(!cls) continue;
                member ??= cls;
                const negate = member.startsWith('!');
                if(negate) member = member.slice(1);
                const on = !!evaluate(data, parseVarSpec(member));
                elem.classList.toggle(cls, negate ? !on : on);
            }
            return [ elem, data ];
        },
        expands: function(elem, data, vs) {
            // - hide the element since we just want to show the clones:
            if(!elem[origStyles]) {
                setExpanderStyle(elem, { display: 'none' });
            }

            // - rescope data by vs;
            data = evaluate(data, parseVarSpec(vs));

            const oldGenEls = elem[generatedElems] ?? { };
            const newGenEls = { };
            if(data) {
                if(typeof(data) === 'string') {
                    // errf.. if it's a string, we don't want it to
                    // expand for each char:
                    data = [ data ];
                }

                // - for each key of data
                //   - copy elem
                //   - continue on copy of elem, passing key as vs
                const oldExpands = elem.dataset.expands;
                delete elem.dataset.expands;
                for(const key of expanderKeys(data)) {
                    if(oldGenEls[key]) {
                        // reuse the old element:
                        newGenEls[key] = oldGenEls[key];
                        delete oldGenEls[key];
                    } else {
                        // no element for this thing yet, so make one:
                        newGenEls[key] = cloneAndExpand(elem, data, key);
                    }
                    updateElements(newGenEls[key], data);

                }
                elem.dataset.expands = oldExpands;

            }
            // remove any orphaned elements (ones for which the
            // data no longer exist) from the DOM:
            for(const key in oldGenEls) {
                oldGenEls[key].remove();
            }
            elem[generatedElems] = newGenEls;

            // callers should consider themselves done with this
            // part of the tree; all other updates will be done
            // on the clones.
            return [ undefined, undefined ];
        },
        shows: function(elem, data, vs) {
            elem[nowShowing] = data;
            doShow(elem, evaluate(data, parseVarSpec(vs)));
            return [ elem, data ];
        },
        controls: function(elem, data, vs) {

            // (normal) controllers always show what they control:
            elem.dataset.shows = vs;

            // 2 possible modes:
            //   - 'control-on-submit' means controls only modify
            //     the data when there's a "change" event (i.e. when
            //     the user hit "return" or exeited the input or whatever)
            //   - the default old-style where the event was fired on
            //     any input
            if(options['control-on-submit']) {
                elem.addEventListener('change', onControlModified);
            } else {
                elem.addEventListener('input',  onControlModified);
            }

            // now that the event handlers are installed,
            // we no longer need/want this:
            delete elem.dataset.controls;

            return [ elem, data ];
        },
    }

    // debugging hook so I can select specific elements to break on:
    const breakOn = {
        //secrets: true,
    };

    // updates the element passed, and all its children
    function updateElements(elem, data) {
        const ds = elem.dataset;
        if(ds && Object.keys(ds).length > 0) {
            for(const updater of controlOrder) {
                if(ds[updater] !== undefined) {
                    if(breakOn[ds[updater]]) {
                        console.log(`give me a break on ${updater} ${ds[updater]}`);
                    }
                    [elem, data] = upFunc[updater](elem, data, ds[updater]);
                }
                if(!elem) {
                    break;
                }
            }
        }

        if(elem) {
            for(const kid of elem.childNodes) {
                updateElements(kid, data);
            }
        }
    }

    function updateDisplays() {
        for(const elem of elements) {
            updateElements(elem, dataSource);
        }
    }

    function initElements(el) {
        // hack to make <dialog> element work:
        // (https://github.com/ccomparini/uiulars/issues/3)
        if(el.tagName === 'DIALOG') {
            // The "value" attribute on some (but not all) elements
            // within a dialog can only be set after the dialog is
            // shown.  So, we need to update dialogs when they are
            // initially shown.  Since there's no onshow event for
            // dialogs, we use an observer hack:
            new MutationObserver(function(mutations)  {
                for(const mut of mutations) {
                    if(mut.attributeName === 'open' && el['open']) {
                        updateElements(el, dataSource);
                    }
                }
            }).observe(el, { attributes: true });
        }
        for(const kid of el.children) {
            initElements(kid);
        }
    }

    // initialize elements once:
    for(const elem of elements) {
        initElements(elem);
    }

    // and do an initial update:
    updateDisplays();

    if(options['poll-interval'] !== undefined) {
        window.setInterval(updateDisplays, options['poll-interval']);
    }

    return {
        version: 0.3,
        initialOptions: options,
        /**
           update() - call this to sync the data to the display
         */
        update: updateDisplays,

        setDataSource: function(newDs) {
            dataSource = newDs;
        }
    };

};
