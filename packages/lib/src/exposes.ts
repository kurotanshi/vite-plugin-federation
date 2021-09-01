import * as path from 'path'
import {
  parseOptions,
  getModuleMarker,
  removeNonLetter,
  normalizePath,
  isSameFilepath
} from './utils'
import {
  EXTERNALS,
  IMPORT_ALIAS,
  DYNAMIC_LOADING_CSS,
  DYNAMIC_LOADING_CSS_PREFIX,
  SHARED,
  EXPOSES_CHUNK_SET,
  EXPOSES_MAP
} from './public'
import { AcornNode, InputOptions, MinimalPluginContext } from 'rollup'
import { VitePluginFederationOptions } from 'types'
import { PluginHooks } from '../types/pluginHooks'
import MagicString from 'magic-string'
import { walk } from 'estree-walker'

export function exposesPlugin(
  options: VitePluginFederationOptions
): PluginHooks {
  let moduleMap = ''
  const replaceMap = new Map()
  const provideExposes = parseOptions(
    options.exposes,
    (item) => ({
      import: item,
      name: undefined
    }),
    (item) => ({
      import: Array.isArray(item.import) ? item.import : [item.import],
      name: item.name || undefined
    })
  )
  // exposes module
  for (const item of provideExposes) {
    const moduleName = getModuleMarker(`\${${item[0]}}`, SHARED)
    EXTERNALS.push(moduleName)
    //EXTERNALS.push(item[0])
    const exposeFilepath = normalizePath(path.resolve(item[1].import))
    EXPOSES_MAP.set(item[0], exposeFilepath)
    moduleMap += `\n"${item[0]}":()=>{
      ${DYNAMIC_LOADING_CSS}('${DYNAMIC_LOADING_CSS_PREFIX}${exposeFilepath}')
      return ${IMPORT_ALIAS}('${exposeFilepath}')
    },`
  }

  return {
    name: 'originjs:exposes',
    virtualFile: {
      // code generated for remote
      __remoteEntryHelper__: `let moduleMap = {${moduleMap}}
    export const ${DYNAMIC_LOADING_CSS} = (cssFilePath) => {
      const metaUrl = import.meta.url
      if (typeof metaUrl == 'undefined') {
        console.warn('The remote style takes effect only when the build.target option in the vite.config.ts file is higher than that of "es2020".')
        return
      }
      const curUrl = metaUrl.substring(0, metaUrl.lastIndexOf('${
        options.filename
      }'))
      const element = document.head.appendChild(document.createElement('link'))
      element.href = curUrl + cssFilePath
      element.rel = 'stylesheet'
    }

    export const get =(module, getScope) => {
        return moduleMap[module]();
    };
    
    export const init =(shareScope, initScope) => {
        let global = window || node;
        global.${getModuleMarker('shared', 'var')}= shareScope
    };`
    },

    options(
      this: MinimalPluginContext,
      _options: InputOptions
    ):
      | Promise<InputOptions | null | undefined>
      | InputOptions
      | null
      | undefined {
      // Split expose & shared module to separate chunks
      _options.preserveEntrySignatures = 'strict'
      if (typeof _options.input === 'string') {
        _options.input = { index: _options.input }
      }
      EXPOSES_MAP.forEach((value, key) => {
        _options.input![removeNonLetter(key)] = value
      })
      EXTERNALS.forEach((item) => {
        if (Array.isArray(_options.external)) {
          _options.external.push(item)
        }
      })
      return null
    },

    buildStart(inputOptions) {
      // if we don't expose any modules, there is no need to emit file
      if (provideExposes.length > 0) {
        this.emitFile({
          fileName: options.filename,
          type: 'chunk',
          id: '__remoteEntryHelper__',
          preserveSignature: 'strict'
        })
      }
    },

    generateBundle(_options, bundle) {
      const moduleFileMap = new Map()
      const cssFileMap = new Map()
      const moduleCssFileMap = new Map()

      for (const file in bundle) {
        if (path.extname(file) === '.css') {
          cssFileMap.set(path.parse(path.parse(file).name).name, file)
        } else {
          moduleFileMap.set(path.parse(path.parse(file).name).name, file)
        }
      }
      cssFileMap.forEach(function (value, key) {
        if (moduleFileMap.get(key) != null) {
          moduleCssFileMap.set(moduleFileMap.get(key), value)
        }
      })

      if (moduleCssFileMap.size === 0) {
        moduleFileMap.forEach(function (value) {
          cssFileMap.forEach(function (cssValue) {
            moduleCssFileMap.set(value, cssValue)
          })
        })
      }

      // replace import absolute path to chunk's fileName in remoteEntry.js
      let remoteEntryChunk
      for (const file in bundle) {
        const chunk = bundle[file]
        if (chunk.type === 'chunk' && chunk.isEntry) {
          if (!remoteEntryChunk && chunk.fileName === options.filename) {
            remoteEntryChunk = chunk
          }
          EXPOSES_MAP.forEach((value) => {
            if (
              chunk.facadeModuleId != null &&
              isSameFilepath(chunk.facadeModuleId, value)
            ) {
              replaceMap.set(value, `./${chunk.fileName}`)
              EXPOSES_CHUNK_SET.add(chunk)
            }
          })
        }
      }
      // placeholder replace
      if (remoteEntryChunk) {
        const item = remoteEntryChunk
        // accurately replace import absolute path to relative path
        replaceMap.forEach((value, key) => {
          item.code = item.code.replace(new RegExp(key + '\\b', 'g'), value)
        })

        // replace __f__dynamic_loading_css__ to dynamicLoadingCss
        moduleCssFileMap.forEach((value, key) => {
          item.code = item.code.replace(
            `("${DYNAMIC_LOADING_CSS_PREFIX}./${key}")`,
            `("${value}")`
          )
          item.code = item.code.replace(
            `('${DYNAMIC_LOADING_CSS_PREFIX}./${key}')`,
            `('${value}')`
          )
        })

        // remove all __f__dynamic_loading_css__ after replace
        let ast: AcornNode | null = null
        try {
          ast = this.parse(item.code)
        } catch (err) {
          console.error(err)
        }
        if (!ast) {
          return
        }
        const magicString = new MagicString(item.code)
        // let cssFunctionName: string = DYNAMIC_LOADING_CSS
        walk(ast, {
          enter(node: any) {
            if (
              node.type === 'CallExpression' &&
              typeof node?.arguments[0]?.value === 'string' &&
              node?.arguments[0]?.value.indexOf(
                `${DYNAMIC_LOADING_CSS_PREFIX}`
              ) > -1
            ) {
              magicString.remove(node.start, node.end + 1)
            }
          }
        })
        item.code = magicString.toString()
      }
    }
  }
}